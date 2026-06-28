from __future__ import annotations

from datetime import datetime, time, timedelta, timezone

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select, text
from sqlalchemy.orm import Session, selectinload

from app.config import settings
from app.db import Base, SessionLocal, engine, get_db
from app.models import ExplicitDependencies, Hospital, HospitalTestCatalog, Lab, LabGroup, LimsConfig, LimsWebhookLog, QueueEntry, QueueStatus, Specialist, TestItem, TestStatus, User, UserRole, Visit
from app.realtime import emit_nowait, mount
from app.schemas import AcceptPendingPayload, CreateHospitalPayload, CreateUserPayload, DeltaResponse, ExplicitDependencyPayload, FrontendPatientPayload, HospitalTestCatalogBulkImport, HospitalTestCatalogUpdate, LabGroupPayload, LabPayload, LimsConfigPayload, LoginPayload, SpecialistPayload, UpdateHospitalPayload, UpdateUserPayload, VisitListResponse, VisitPayload
from app.seed import reset_database, seed_database
from app.catalog import test_catalog_map
from app.auth import _init_firebase, create_firebase_user, generate_api_key, get_current_user, get_lims_hospital, require_role, update_firebase_user, verify_firebase_token
from firebase_admin import auth as firebase_auth
from app.services.bootstrap import admin_dashboard_payload, bootstrap_payload, delta_payload, frontend_lab, frontend_lab_group, frontend_service_management, frontend_specialist, frontend_test_catalog, frontend_visit, hospital_catalog_map, paginated_visits, waiting_candidates_payload
from app.services.patient_ids import build_patient_id, extract_sequence, patient_id_date
from app.services.queue import QueueService
from app.services.scheduling import SchedulingService
from app.services.or_scheduler import ORScheduler
from app.services.planning_poker import PlanningPokerService, VotingStatus

app = FastAPI(title='Scalable Lab Scheduling Backend')


def _ensure_schema() -> None:
    Base.metadata.create_all(bind=engine)
    with engine.begin() as connection:
        connection.execute(text("ALTER TABLE visits ADD COLUMN IF NOT EXISTS phone VARCHAR(20)"))
        connection.execute(text("ALTER TABLE test_items ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT FALSE NOT NULL"))
        connection.execute(text("ALTER TABLE test_items ADD COLUMN IF NOT EXISTS priority_flag VARCHAR(20) DEFAULT 'NONE' NOT NULL"))
        connection.execute(text("ALTER TABLE labs ADD COLUMN IF NOT EXISTS group_id INTEGER"))
        for tbl in ['specialists', 'lab_groups', 'labs', 'visits', 'test_items',
                     'queue_entries', 'queue_cursors', 'assignment_history', 'completed_test_snapshots']:
            connection.execute(text(f"ALTER TABLE {tbl} ADD COLUMN IF NOT EXISTS hospital_id INTEGER REFERENCES hospitals(id) ON DELETE CASCADE"))
        connection.execute(text("ALTER TABLE specialists ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL"))
        connection.execute(text("ALTER TABLE test_items ADD COLUMN IF NOT EXISTS allocated_at TIMESTAMP WITH TIME ZONE"))
        connection.execute(text("ALTER TABLE test_items ADD COLUMN IF NOT EXISTS started_at TIMESTAMP WITH TIME ZONE"))
        connection.execute(text("ALTER TABLE explicit_dependencies ADD COLUMN IF NOT EXISTS hospital_id INTEGER REFERENCES hospitals(id) ON DELETE CASCADE"))
        connection.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_specialists_user_id ON specialists(user_id)"))


def _seed_default_hospital_and_users() -> None:
    with SessionLocal() as db:
        hospital = db.scalar(select(Hospital).where(Hospital.code == 'DEMO'))
        if not hospital:
            hospital = Hospital(name='Demo Hospital', code='DEMO', is_active=True)
            db.add(hospital)
            db.flush()
            # Backfill existing rows
            for tbl in ['specialists', 'lab_groups', 'labs', 'visits', 'test_items',
                         'queue_entries', 'queue_cursors', 'assignment_history', 'completed_test_snapshots']:
                db.execute(text(f"UPDATE {tbl} SET hospital_id = :hid WHERE hospital_id IS NULL"), {'hid': hospital.id})
            db.commit()
        # Seed default Super Admin user if none exists
        if not db.scalar(select(User).where(User.role == UserRole.SUPER_ADMIN)):
            try:
                firebase_uid = create_firebase_user(
                    email='admin@demo.com',
                    password='Admin@123',
                    display_name='Super Admin',
                )
            except Exception:
                # Firebase user may already exist; look up by email
                _init_firebase()
                try:
                    fb_user = firebase_auth.get_user_by_email('admin@demo.com')
                    firebase_uid = fb_user.uid
                except Exception:
                    firebase_uid = None
            if firebase_uid:
                db.add(User(
                    firebase_uid=firebase_uid,
                    email='admin@demo.com',
                    display_name='Super Admin',
                    role=UserRole.SUPER_ADMIN,
                    hospital_id=hospital.id,
                    is_active=True,
                ))
                db.commit()


@app.on_event('startup')
def startup() -> None:
    _ensure_schema()
    with SessionLocal() as session:
        if settings.reset_db_on_startup:
            reset_database(session)
    _seed_default_hospital_and_users()
    with SessionLocal() as session:
        if settings.seed_on_startup:
            seed_database(session)


def _next_public_id(db: Session, arrival_time: datetime) -> str:
    local_arrival = arrival_time.astimezone() if arrival_time.tzinfo else arrival_time
    visit_date = patient_id_date(local_arrival)
    start_of_day = local_arrival.replace(hour=0, minute=0, second=0, microsecond=0)
    end_of_day = start_of_day + timedelta(days=1)
    existing_ids = db.scalars(
        select(Visit.public_id)
        .where(Visit.arrival_time >= start_of_day, Visit.arrival_time < end_of_day)
        .order_by(Visit.id.asc())
    ).all()
    sequences = [seq for public_id in existing_ids if (seq := extract_sequence(public_id, visit_date)) is not None]
    sequence = (max(sequences) + 1) if sequences else 0
    return build_patient_id(visit_date, sequence)


ROLE_CREATION_RULES: dict[UserRole, set[UserRole]] = {
    UserRole.SUPER_ADMIN: {
        UserRole.SUPER_ADMIN,
        UserRole.ADMIN,
        UserRole.RECEPTIONIST,
        UserRole.LAB_SPECIALIST,
    },
    UserRole.ADMIN: {
        UserRole.ADMIN,
        UserRole.RECEPTIONIST,
        UserRole.LAB_SPECIALIST,
    },
    UserRole.RECEPTIONIST: {
        UserRole.LAB_SPECIALIST,
    },
}


def _parse_optional_shift(value: str | None) -> time | None:
    if not value:
        return None
    return datetime.strptime(value[:5], '%H:%M').time()


def _resolve_target_hospital_id(
    creator: UserRole,
    requested_hospital_id: int | None,
    current_user: User | None,
    db: Session,
    target_role: UserRole,
) -> int | None:
    if creator == UserRole.SUPER_ADMIN:
        if target_role == UserRole.SUPER_ADMIN:
            return None
        if requested_hospital_id is None:
            raise HTTPException(status_code=400, detail='hospital_id required for non-SuperAdmin users')
        hospital = db.get(Hospital, requested_hospital_id)
        if not hospital:
            raise HTTPException(status_code=404, detail='Hospital not found')
        return hospital.id

    if current_user is None or current_user.hospital_id is None:
        raise HTTPException(status_code=400, detail='Current user is not assigned to a hospital')

    if requested_hospital_id not in (None, current_user.hospital_id):
        raise HTTPException(status_code=403, detail='Cannot create users for another hospital')

    return current_user.hospital_id


def _specialist_defaults(payload: CreateUserPayload, creator_role: UserRole) -> tuple[str, time, time]:
    gender = payload.gender or 'Other'
    shift_start = _parse_optional_shift(payload.shift_start)
    shift_end = _parse_optional_shift(payload.shift_end)

    if creator_role == UserRole.RECEPTIONIST:
        if not payload.gender or shift_start is None or shift_end is None:
            raise HTTPException(
                status_code=400,
                detail='gender, shift_start, and shift_end are required when Receptionist creates a LabSpecialist',
            )

    return (
        gender,
        shift_start or time(hour=8, minute=0),
        shift_end or time(hour=16, minute=0),
    )


def _create_user_with_permissions(
    payload: CreateUserPayload,
    *,
    creator_role: UserRole,
    db: Session,
    current_user: User | None = None,
) -> dict:
    try:
        target_role = UserRole(payload.role)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail='Invalid role') from exc

    allowed_roles = ROLE_CREATION_RULES.get(creator_role, set())
    if target_role not in allowed_roles:
        raise HTTPException(status_code=403, detail='Insufficient permissions to create this role')

    hospital_id = _resolve_target_hospital_id(creator_role, payload.hospital_id, current_user, db, target_role)

    if db.scalar(select(User).where(User.email == payload.email)):
        raise HTTPException(status_code=400, detail='Email already exists')

    try:
        firebase_uid = create_firebase_user(payload.email, payload.password, payload.display_name)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f'Firebase user creation failed: {exc}')

    db_user = User(
        firebase_uid=firebase_uid,
        email=payload.email,
        display_name=payload.display_name,
        role=target_role,
        hospital_id=hospital_id,
        is_active=True,
    )
    db.add(db_user)
    db.flush()

    specialist = None
    if target_role == UserRole.LAB_SPECIALIST:
        gender, shift_start, shift_end = _specialist_defaults(payload, creator_role)
        specialist = Specialist(
            user_id=db_user.id,
            name=payload.display_name,
            gender=gender,
            shift_start=shift_start,
            shift_end=shift_end,
            is_active=True,
            hospital_id=hospital_id,
        )
        db.add(specialist)
        db.flush()

    db.commit()

    return {
        'id': db_user.id,
        'email': db_user.email,
        'display_name': db_user.display_name,
        'role': db_user.role.value,
        'hospital_id': db_user.hospital_id,
        'firebase_uid': firebase_uid,
        'specialist_id': specialist.id if specialist else None,
        'specialist': frontend_specialist(specialist) if specialist else None,
    }


def _hospital_users_payload(db: Session, hospital_id: int) -> list[dict]:
    users = db.scalars(
        select(User)
        .where(User.hospital_id == hospital_id)
        .order_by(User.id.asc())
    ).all()
    return [
        {
            'id': u.id,
            'email': u.email,
            'display_name': u.display_name,
            'role': u.role.value,
            'hospital_id': u.hospital_id,
            'is_active': u.is_active,
            'hospital_name': db.get(Hospital, u.hospital_id).name if u.hospital_id else None,
        }
        for u in users
    ]


def _hospital_payload(hospital: Hospital) -> dict:
    return {
        'id': hospital.id,
        'name': hospital.name,
        'code': hospital.code,
        'is_active': hospital.is_active,
    }


def _update_super_admin_hospital(hospital_id: int, payload: UpdateHospitalPayload, db: Session) -> dict:
    hospital = db.get(Hospital, hospital_id)
    if not hospital:
        raise HTTPException(status_code=404, detail='Hospital not found')

    existing = db.scalar(select(Hospital).where(Hospital.code == payload.code, Hospital.id != hospital_id))
    if existing:
        raise HTTPException(status_code=400, detail='Hospital code already exists')

    hospital.name = payload.name
    hospital.code = payload.code
    hospital.is_active = payload.is_active
    db.commit()
    return _hospital_payload(hospital)


def _set_hospital_active_state(hospital_id: int, is_active: bool, db: Session) -> dict:
    hospital = db.get(Hospital, hospital_id)
    if not hospital:
        raise HTTPException(status_code=404, detail='Hospital not found')
    hospital.is_active = is_active
    db.commit()
    return _hospital_payload(hospital)


def _delete_super_admin_hospital(hospital_id: int, db: Session) -> dict:
    hospital = db.get(Hospital, hospital_id)
    if not hospital:
        raise HTTPException(status_code=404, detail='Hospital not found')
    hospital_name = hospital.name
    db.delete(hospital)
    db.commit()
    return {'message': f'Hospital {hospital_name} deleted'}


def _update_super_admin_user(user_id: int, payload: UpdateUserPayload, db: Session) -> dict:
    db_user = db.get(User, user_id)
    if not db_user:
        raise HTTPException(status_code=404, detail='User not found')

    try:
        target_role = UserRole(payload.role)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail='Invalid role') from exc

    if payload.hospital_id is not None:
        hospital = db.get(Hospital, payload.hospital_id)
        if not hospital:
            raise HTTPException(status_code=404, detail='Hospital not found')

    if target_role != UserRole.SUPER_ADMIN and payload.hospital_id is None:
        raise HTTPException(status_code=400, detail='hospital_id required for non-SuperAdmin users')

    if target_role == UserRole.SUPER_ADMIN:
        payload_hospital_id = None
    else:
        payload_hospital_id = payload.hospital_id

    email_conflict = db.scalar(select(User).where(User.email == payload.email, User.id != user_id))
    if email_conflict:
        raise HTTPException(status_code=400, detail='Email already exists')

    update_firebase_user(
        db_user.firebase_uid,
        email=payload.email,
        password=payload.password or None,
        display_name=payload.display_name,
    )

    previous_role = db_user.role
    db_user.email = payload.email
    db_user.display_name = payload.display_name
    db_user.role = target_role
    db_user.hospital_id = payload_hospital_id

    specialist = db.scalar(select(Specialist).where(Specialist.user_id == db_user.id))

    if target_role == UserRole.LAB_SPECIALIST:
        gender = payload.gender or specialist.gender if specialist else (payload.gender or 'Other')
        shift_start = _parse_optional_shift(payload.shift_start) or (specialist.shift_start if specialist else time(hour=8, minute=0))
        shift_end = _parse_optional_shift(payload.shift_end) or (specialist.shift_end if specialist else time(hour=16, minute=0))

        if specialist is None:
            specialist = Specialist(
                user_id=db_user.id,
                name=payload.display_name,
                gender=gender,
                shift_start=shift_start,
                shift_end=shift_end,
                is_active=db_user.is_active,
                hospital_id=payload_hospital_id,
            )
            db.add(specialist)
        else:
            specialist.name = payload.display_name
            specialist.gender = gender
            specialist.shift_start = shift_start
            specialist.shift_end = shift_end
            specialist.is_active = db_user.is_active
            specialist.hospital_id = payload_hospital_id
    elif specialist is not None and previous_role == UserRole.LAB_SPECIALIST:
        db.delete(specialist)
        specialist = None

    db.commit()

    return {
        'id': db_user.id,
        'email': db_user.email,
        'display_name': db_user.display_name,
        'role': db_user.role.value,
        'hospital_id': db_user.hospital_id,
        'is_active': db_user.is_active,
        'specialist_id': specialist.id if specialist else None,
    }


def _set_super_admin_user_active_state(user_id: int, is_active: bool, db: Session) -> dict:
    db_user = db.get(User, user_id)
    if not db_user:
        raise HTTPException(status_code=404, detail='User not found')

    db_user.is_active = is_active
    specialist = db.scalar(select(Specialist).where(Specialist.user_id == db_user.id))
    if specialist:
        specialist.is_active = is_active
    db.commit()
    return {
        'id': db_user.id,
        'email': db_user.email,
        'display_name': db_user.display_name,
        'role': db_user.role.value,
        'hospital_id': db_user.hospital_id,
        'is_active': db_user.is_active,
    }


def _delete_super_admin_user(user_id: int, db: Session) -> dict:
    db_user = db.get(User, user_id)
    if not db_user:
        raise HTTPException(status_code=404, detail='User not found')

    firebase_uid = db_user.firebase_uid
    specialist = db.scalar(select(Specialist).where(Specialist.user_id == db_user.id))
    display_name = db_user.display_name

    if specialist:
        db.delete(specialist)
    db.delete(db_user)
    db.commit()

    try:
        _init_firebase()
        firebase_auth.delete_user(firebase_uid)
    except Exception:
        pass

    return {'message': f'User {display_name} deleted'}


def _requested_frontend_tests(payload: FrontendPatientPayload) -> list[dict[str, str]]:
    if payload.test_details:
        return [
            {
                'test_name': item.test_name,
                'priority_flag': item.priority_flag or 'NONE',
            }
            for item in payload.test_details
        ]
    return [{'test_name': test_name, 'priority_flag': 'NONE'} for test_name in payload.test_names]


def _apply_frontend_patient_payload(db: Session, visit: Visit, payload: FrontendPatientPayload, reason: str, hospital_id: int | None = None) -> Visit:
    requested_tests = _requested_frontend_tests(payload)
    if not requested_tests:
        raise HTTPException(status_code=400, detail='At least one test is required')
    catalog = hospital_catalog_map(db, hospital_id)
    invalid_tests = [item['test_name'] for item in requested_tests if item['test_name'] not in catalog]
    if invalid_tests:
        raise HTTPException(status_code=400, detail=f'Unknown tests: {", ".join(invalid_tests)}')

    visit.patient_name = payload.patient_name
    visit.patient_age = payload.patient_age
    visit.patient_gender = payload.patient_gender
    visit.priority_type = payload.priority_type
    visit.phone = payload.phone or None
    visit.patient_snapshot = {**(visit.patient_snapshot or {}), 'phone': payload.phone}

    preserved_tests: list[TestItem] = []
    editable_tests: list[TestItem] = []
    for test in visit.tests:
        # Only WAITING tests can be edited or removed
        # All other statuses are locked: COMPLETED, IN_PROGRESS, CURRENT, PENDING
        if test.queue_status == QueueStatus.WAITING:
            editable_tests.append(test)
        else:
            preserved_tests.append(test)

    remaining_requested: dict[str, list[str]] = {}
    for item in requested_tests:
        remaining_requested.setdefault(item['test_name'], []).append(item['priority_flag'] or 'NONE')

    for test in preserved_tests:
        priorities = remaining_requested.get(test.test_name, [])
        if priorities:
            test.priority_flag = priorities.pop(0)

    for test in editable_tests:
        priorities = remaining_requested.get(test.test_name, [])
        if priorities:
            item = catalog[test.test_name]
            test.test_code = item['test_code']
            test.category = item['category']
            test.duration_minutes = int(item['duration_minutes'])
            test.tags = list(item.get('tags', []))
            test.condition_category = item.get('condition_category')
            test.priority_flag = priorities.pop(0)
            continue
        queue_entries = db.scalars(select(QueueEntry).where(QueueEntry.test_item_id == test.id)).all()
        for entry in queue_entries:
            db.delete(entry)
        db.delete(test)

    db.flush()

    for test_name, priorities in remaining_requested.items():
        item = catalog[test_name]
        for priority_flag in priorities:
            db.add(TestItem(
                visit_id=visit.id,
                test_code=item['test_code'],
                test_name=item['test_name'],
                category=item['category'],
                duration_minutes=int(item['duration_minutes']),
                tags=list(item.get('tags', [])),
                condition_category=item.get('condition_category'),
                priority_flag=priority_flag or 'NONE',
            ))

    db.flush()
    # Note: OR optimization is triggered by the caller after this function returns
    refreshed = db.scalar(select(Visit).where(Visit.id == visit.id).options(selectinload(Visit.tests)))
    return refreshed or visit


@app.get('/api/health')
def health():
    return {'status': 'ok'}


# ===== Bootstrap: create initial Firebase users (one-time, no auth required) =====

@app.post('/api/auth/bootstrap-users')
def bootstrap_users(db: Session = Depends(get_db)):
    if db.scalar(select(User).where(User.role == UserRole.SUPER_ADMIN)):
        raise HTTPException(status_code=400, detail='Users already bootstrapped')

    hospital = db.scalar(select(Hospital).where(Hospital.code == 'DEMO'))
    if not hospital:
        hospital = Hospital(name='Demo Hospital', code='DEMO', is_active=True)
        db.add(hospital)
        db.flush()

    seed_users = [
        ('superadmin@labscheduling.com', 'Super@123', 'Super Admin', UserRole.SUPER_ADMIN, None),
        ('admin@demo.com', 'Admin@123', 'Demo Admin', UserRole.ADMIN, hospital.id),
        ('receptionist@demo.com', 'Recep@123', 'Demo Receptionist', UserRole.RECEPTIONIST, hospital.id),
        ('labspecialist@demo.com', 'Lab@1234', 'Demo Lab Specialist', UserRole.LAB_SPECIALIST, hospital.id),
    ]

    created = []
    for email, password, display_name, role, h_id in seed_users:
        result = _create_user_with_permissions(
            CreateUserPayload(
                email=email,
                password=password,
                display_name=display_name,
                role=role.value,
                hospital_id=h_id,
                gender='Other' if role == UserRole.LAB_SPECIALIST else None,
                shift_start='08:00' if role == UserRole.LAB_SPECIALIST else None,
                shift_end='16:00' if role == UserRole.LAB_SPECIALIST else None,
            ),
            creator_role=UserRole.SUPER_ADMIN,
            db=db,
        )
        created.append({'email': email, 'password': password, 'role': role.value, 'id': result['id']})

    return {'created': created}


# ===== Auth Endpoints =====

@app.post('/api/auth/login')
def auth_login(payload: LoginPayload, db: Session = Depends(get_db)):
    import logging
    logger = logging.getLogger('auth_debug')
    try:
        decoded = verify_firebase_token(payload.firebase_token)
    except HTTPException as e:
        logger.error('verify_firebase_token failed: %s', e.detail)
        raise
    uid = decoded.get('uid')
    logger.info('Decoded token uid=%s', uid)
    if not uid:
        raise HTTPException(status_code=401, detail='Invalid token')
    user = db.scalar(select(User).where(User.firebase_uid == uid, User.is_active == True))
    if not user:
        raise HTTPException(status_code=403, detail='User not registered in system')
    hospital = db.get(Hospital, user.hospital_id) if user.hospital_id else None
    if user.role != UserRole.SUPER_ADMIN and hospital and not hospital.is_active:
        raise HTTPException(status_code=403, detail='Hospital is disabled')
    return {
        'user': {
            'id': user.id,
            'email': user.email,
            'display_name': user.display_name,
            'role': user.role.value,
            'hospital_id': user.hospital_id,
            'hospital_name': hospital.name if hospital else None,
            'hospital_code': hospital.code if hospital else None,
        }
    }


@app.get('/api/auth/me')
def auth_me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    hospital = db.get(Hospital, user.hospital_id) if user.hospital_id else None
    return {
        'id': user.id,
        'email': user.email,
        'display_name': user.display_name,
        'role': user.role.value,
        'hospital_id': user.hospital_id,
        'hospital_name': hospital.name if hospital else None,
        'hospital_code': hospital.code if hospital else None,
    }


# ===== Super Admin Endpoints =====

@app.get('/api/super-admin/hospitals')
def list_hospitals(user: User = Depends(require_role(UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    hospitals = db.scalars(select(Hospital).order_by(Hospital.id.asc())).all()
    return [_hospital_payload(h) for h in hospitals]


@app.post('/api/super-admin/hospitals')
def create_hospital(payload: CreateHospitalPayload, user: User = Depends(require_role(UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    if db.scalar(select(Hospital).where(Hospital.code == payload.code)):
        raise HTTPException(status_code=400, detail='Hospital code already exists')
    hospital = Hospital(name=payload.name, code=payload.code, is_active=True)
    db.add(hospital)
    db.commit()
    return _hospital_payload(hospital)


@app.patch('/api/super-admin/hospitals/{hospital_id}')
def update_hospital(hospital_id: int, payload: UpdateHospitalPayload, user: User = Depends(require_role(UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    return _update_super_admin_hospital(hospital_id, payload, db)


@app.delete('/api/super-admin/hospitals/{hospital_id}')
def delete_hospital(hospital_id: int, user: User = Depends(require_role(UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    return _delete_super_admin_hospital(hospital_id, db)


@app.post('/api/super-admin/hospitals/{hospital_id}/disable')
def disable_hospital(hospital_id: int, user: User = Depends(require_role(UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    return _set_hospital_active_state(hospital_id, False, db)


@app.post('/api/super-admin/hospitals/{hospital_id}/enable')
def enable_hospital(hospital_id: int, user: User = Depends(require_role(UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    return _set_hospital_active_state(hospital_id, True, db)


@app.get('/api/super-admin/users')
def list_users(user: User = Depends(require_role(UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    users = db.scalars(select(User).order_by(User.id.asc())).all()
    return [
        {
            'id': u.id, 'email': u.email, 'display_name': u.display_name,
            'role': u.role.value, 'hospital_id': u.hospital_id, 'is_active': u.is_active,
            'hospital_name': db.get(Hospital, u.hospital_id).name if u.hospital_id else None,
        }
        for u in users
    ]


@app.post('/api/super-admin/users')
async def create_user(payload: CreateUserPayload, user: User = Depends(require_role(UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    return _create_user_with_permissions(payload, creator_role=UserRole.SUPER_ADMIN, db=db, current_user=user)


@app.patch('/api/super-admin/users/{user_id}')
async def update_super_admin_user(user_id: int, payload: UpdateUserPayload, user: User = Depends(require_role(UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    return _update_super_admin_user(user_id, payload, db)


@app.delete('/api/super-admin/users/{user_id}')
async def delete_super_admin_user(user_id: int, user: User = Depends(require_role(UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    return _delete_super_admin_user(user_id, db)


@app.post('/api/super-admin/users/{user_id}/disable')
async def disable_super_admin_user(user_id: int, user: User = Depends(require_role(UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    return _set_super_admin_user_active_state(user_id, False, db)


@app.post('/api/super-admin/users/{user_id}/enable')
async def enable_super_admin_user(user_id: int, user: User = Depends(require_role(UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    return _set_super_admin_user_active_state(user_id, True, db)


@app.get('/api/admin/users')
def list_admin_users(user: User = Depends(require_role(UserRole.ADMIN)), db: Session = Depends(get_db)):
    return _hospital_users_payload(db, user.hospital_id)


@app.post('/api/admin/users')
async def create_admin_user(payload: CreateUserPayload, user: User = Depends(require_role(UserRole.ADMIN)), db: Session = Depends(get_db)):
    return _create_user_with_permissions(payload, creator_role=UserRole.ADMIN, db=db, current_user=user)


@app.post('/api/receptionist/lab-specialists')
async def create_receptionist_lab_specialist(payload: CreateUserPayload, user: User = Depends(require_role(UserRole.RECEPTIONIST)), db: Session = Depends(get_db)):
    result = _create_user_with_permissions(payload, creator_role=UserRole.RECEPTIONIST, db=db, current_user=user)
    specialist_payload = result.get('specialist')
    if specialist_payload:
        emit_nowait('specialist.updated', specialist_payload)
        emit_nowait('dashboard.metrics.updated', admin_dashboard_payload(db, hospital_id=user.hospital_id))
        return specialist_payload
    raise HTTPException(status_code=500, detail='LabSpecialist creation did not produce a specialist record')


# ===== LIMS Config (SuperAdmin) =====

@app.get('/api/super-admin/hospitals/{hospital_id}/lims-config')
def get_lims_config(hospital_id: int, user: User = Depends(require_role(UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    config = db.scalar(select(LimsConfig).where(LimsConfig.hospital_id == hospital_id))
    if not config:
        return {'hospital_id': hospital_id, 'callback_url': None, 'is_enabled': False, 'has_api_key': False}
    return {
        'hospital_id': config.hospital_id,
        'callback_url': config.callback_url,
        'is_enabled': config.is_enabled,
        'has_api_key': bool(config.api_key_hash),
    }


@app.post('/api/super-admin/hospitals/{hospital_id}/lims-config')
def create_or_update_lims_config(hospital_id: int, payload: LimsConfigPayload, user: User = Depends(require_role(UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    if not db.get(Hospital, hospital_id):
        raise HTTPException(status_code=404, detail='Hospital not found')
    config = db.scalar(select(LimsConfig).where(LimsConfig.hospital_id == hospital_id))
    if config:
        config.callback_url = payload.callback_url
        config.is_enabled = payload.is_enabled
    else:
        config = LimsConfig(
            hospital_id=hospital_id,
            callback_url=payload.callback_url,
            is_enabled=payload.is_enabled,
        )
        db.add(config)
    db.commit()
    return {
        'hospital_id': config.hospital_id,
        'callback_url': config.callback_url,
        'is_enabled': config.is_enabled,
        'has_api_key': bool(config.api_key_hash),
    }


@app.post('/api/super-admin/hospitals/{hospital_id}/lims-config/regenerate-key')
def regenerate_lims_api_key(hospital_id: int, user: User = Depends(require_role(UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    if not db.get(Hospital, hospital_id):
        raise HTTPException(status_code=404, detail='Hospital not found')
    config = db.scalar(select(LimsConfig).where(LimsConfig.hospital_id == hospital_id))
    if not config:
        config = LimsConfig(hospital_id=hospital_id)
        db.add(config)
    plaintext, hashed = generate_api_key()
    config.api_key_hash = hashed
    db.commit()
    return {
        'api_key': plaintext,
        'hospital_id': hospital_id,
        'message': 'Store this key securely — it cannot be retrieved again.',
    }


# ===== Frontend Endpoints (hospital-scoped) =====

@app.get('/api/frontend/bootstrap')
def bootstrap(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return bootstrap_payload(db, hospital_id=user.hospital_id)


@app.get('/api/frontend/admin-dashboard')
def admin_dashboard(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return admin_dashboard_payload(db, hospital_id=user.hospital_id)


@app.get('/api/frontend/test-catalog')
def frontend_test_catalog_route(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return {'items': frontend_test_catalog(db, hospital_id=user.hospital_id)}


@app.get('/api/frontend/service-management')
def frontend_service_management_route(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return frontend_service_management(db, hospital_id=user.hospital_id)


# ===== Hospital Test Catalog CRUD (Admin/SuperAdmin) =====

@app.get('/api/hospital-catalog')
def list_hospital_catalog(user: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    entries = db.scalars(
        select(HospitalTestCatalog)
        .where(HospitalTestCatalog.hospital_id == user.hospital_id)
        .order_by(HospitalTestCatalog.test_name.asc())
    ).all()
    return [
        {
            'id': e.id, 'test_code': e.test_code, 'test_name': e.test_name,
            'category': e.category, 'duration_minutes': e.duration_minutes,
            'tags': list(e.tags or []), 'condition_category': e.condition_category,
            'is_active': e.is_active,
        }
        for e in entries
    ]


@app.post('/api/hospital-catalog/bulk-import')
def bulk_import_hospital_catalog(payload: HospitalTestCatalogBulkImport, user: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    from app.catalog import build_test_catalog
    global_map = {item['test_code']: item for item in build_test_catalog()}
    existing_codes = set(db.scalars(
        select(HospitalTestCatalog.test_code).where(HospitalTestCatalog.hospital_id == user.hospital_id)
    ).all())
    imported = []
    for code in payload.test_codes:
        if code in existing_codes:
            continue
        item = global_map.get(code)
        if not item:
            continue
        entry = HospitalTestCatalog(
            hospital_id=user.hospital_id,
            test_code=item['test_code'],
            test_name=item['test_name'],
            category=item['category'],
            duration_minutes=int(item['duration_minutes']),
            tags=list(item.get('tags', [])),
            condition_category=item.get('condition_category'),
            is_active=True,
        )
        db.add(entry)
        imported.append(item['test_code'])
    db.commit()
    return {'imported': len(imported), 'test_codes': imported}


@app.post('/api/hospital-catalog/import-all')
def import_all_hospital_catalog(user: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    from app.catalog import build_test_catalog
    existing_codes = set(db.scalars(
        select(HospitalTestCatalog.test_code).where(HospitalTestCatalog.hospital_id == user.hospital_id)
    ).all())
    imported = 0
    for item in build_test_catalog():
        if item['test_code'] in existing_codes:
            continue
        db.add(HospitalTestCatalog(
            hospital_id=user.hospital_id,
            test_code=item['test_code'],
            test_name=item['test_name'],
            category=item['category'],
            duration_minutes=int(item['duration_minutes']),
            tags=list(item.get('tags', [])),
            condition_category=item.get('condition_category'),
            is_active=True,
        ))
        imported += 1
    db.commit()
    return {'imported': imported}


@app.patch('/api/hospital-catalog/{test_code}')
def update_hospital_catalog_entry(test_code: str, payload: HospitalTestCatalogUpdate, user: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    entry = db.scalar(
        select(HospitalTestCatalog).where(
            HospitalTestCatalog.hospital_id == user.hospital_id,
            HospitalTestCatalog.test_code == test_code,
        )
    )
    if not entry:
        raise HTTPException(status_code=404, detail='Catalog entry not found')
    if payload.duration_minutes is not None:
        entry.duration_minutes = payload.duration_minutes
    if payload.is_active is not None:
        entry.is_active = payload.is_active
    db.commit()
    return {
        'id': entry.id, 'test_code': entry.test_code, 'test_name': entry.test_name,
        'category': entry.category, 'duration_minutes': entry.duration_minutes,
        'is_active': entry.is_active,
    }


@app.delete('/api/hospital-catalog/{test_code}')
def delete_hospital_catalog_entry(test_code: str, user: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    entry = db.scalar(
        select(HospitalTestCatalog).where(
            HospitalTestCatalog.hospital_id == user.hospital_id,
            HospitalTestCatalog.test_code == test_code,
        )
    )
    if not entry:
        raise HTTPException(status_code=404, detail='Catalog entry not found')
    db.delete(entry)
    db.commit()
    return {'message': f'Test {test_code} removed from hospital catalog'}


@app.get('/api/hospital-catalog/global')
def list_global_catalog(user: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN))):
    from app.catalog import build_test_catalog
    return [
        {
            'test_code': item['test_code'], 'test_name': item['test_name'],
            'category': item['category'], 'duration_minutes': item['duration_minutes'],
            'tags': list(item.get('tags', [])), 'condition_category': item.get('condition_category'),
        }
        for item in build_test_catalog()
    ]


# ===== Dependency CRUD (Admin/SuperAdmin) =====

@app.get('/api/dependencies')
def list_dependencies(user: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    from sqlalchemy import or_
    rules = db.scalars(
        select(ExplicitDependencies)
        .where(or_(
            ExplicitDependencies.hospital_id == None,
            ExplicitDependencies.hospital_id == user.hospital_id,
        ))
        .order_by(ExplicitDependencies.test_code.asc())
    ).all()
    return [
        {
            'id': r.id, 'test_code': r.test_code, 'depends_on_test_code': r.depends_on_test_code,
            'dependency_type': r.dependency_type, 'is_strict': r.is_strict,
            'is_global': r.hospital_id is None,
        }
        for r in rules
    ]


@app.post('/api/dependencies')
def create_dependency(payload: ExplicitDependencyPayload, user: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    existing = db.scalar(
        select(ExplicitDependencies).where(
            ExplicitDependencies.test_code == payload.test_code,
            ExplicitDependencies.depends_on_test_code == payload.depends_on_test_code,
            ExplicitDependencies.hospital_id == user.hospital_id,
        )
    )
    if existing:
        raise HTTPException(status_code=400, detail='Dependency rule already exists')
    rule = ExplicitDependencies(
        test_code=payload.test_code,
        depends_on_test_code=payload.depends_on_test_code,
        dependency_type=payload.dependency_type,
        is_strict=payload.is_strict,
        hospital_id=user.hospital_id,
    )
    db.add(rule)
    db.commit()
    return {
        'id': rule.id, 'test_code': rule.test_code, 'depends_on_test_code': rule.depends_on_test_code,
        'dependency_type': rule.dependency_type, 'is_strict': rule.is_strict, 'is_global': False,
    }


@app.delete('/api/dependencies/{dep_id}')
def delete_dependency(dep_id: int, user: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    rule = db.get(ExplicitDependencies, dep_id)
    if not rule:
        raise HTTPException(status_code=404, detail='Dependency not found')
    if rule.hospital_id is None:
        raise HTTPException(status_code=403, detail='Cannot delete global dependency rules')
    if rule.hospital_id != user.hospital_id:
        raise HTTPException(status_code=403, detail='Cannot delete another hospital\'s dependency')
    db.delete(rule)
    db.commit()
    return {'message': 'Dependency rule deleted'}


@app.post('/api/frontend/patients')
async def create_frontend_patient(payload: FrontendPatientPayload, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    requested_tests = _requested_frontend_tests(payload)
    if not requested_tests:
        raise HTTPException(status_code=400, detail='At least one test is required')
    catalog = hospital_catalog_map(db, user.hospital_id)
    invalid_tests = [item['test_name'] for item in requested_tests if item['test_name'] not in catalog]
    if invalid_tests:
        raise HTTPException(status_code=400, detail=f'Unknown tests: {", ".join(invalid_tests)}')
    now = datetime.now().astimezone()
    visit = Visit(
        public_id=_next_public_id(db, now),
        phr_reference_id=f'PHR-MANUAL-{now.strftime("%Y%m%d%H%M%S%f")}',
        patient_name=payload.patient_name,
        patient_age=payload.patient_age,
        patient_gender=payload.patient_gender,
        priority_type=payload.priority_type,
        phone=payload.phone or None,
        arrival_time=now,
        patient_snapshot={'phone': payload.phone},
        hospital_id=user.hospital_id,
    )
    db.add(visit)
    db.flush()
    for requested_test in requested_tests:
        item = catalog[requested_test['test_name']]
        from app.models import TestStatus, QueueStatus
        db.add(TestItem(
            visit_id=visit.id,
            test_code=item['test_code'],
            test_name=item['test_name'],
            category=item['category'],
            duration_minutes=int(item['duration_minutes']),
            tags=list(item.get('tags', [])),
            condition_category=item.get('condition_category'),
            priority_flag=requested_test['priority_flag'] or 'NONE',
            status=TestStatus.SCHEDULED,
            queue_status=QueueStatus.WAITING,
            hospital_id=user.hospital_id,
        ))
    db.flush()
    # CRITICAL FIX: Use ORScheduler instead of deprecated SchedulingService
    or_scheduler = ORScheduler(db, hospital_id=user.hospital_id)
    or_scheduler.run_optimization()
    db.commit()
    response = frontend_visit(visit)
    visit = db.scalar(select(Visit).where(Visit.id == visit.id).options(selectinload(Visit.tests))) or visit
    response = frontend_visit(visit)
    emit_nowait('visit.updated', response)
    emit_nowait('dashboard.metrics.updated', admin_dashboard_payload(db))
    return response


@app.patch('/api/frontend/patients/{visit_public_id}')
async def update_frontend_patient(visit_public_id: str, payload: FrontendPatientPayload, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    visit = db.scalar(select(Visit).where(Visit.public_id == visit_public_id).options(selectinload(Visit.tests)))
    if visit is None:
        raise HTTPException(status_code=404, detail='Patient visit not found')
    visit = _apply_frontend_patient_payload(db, visit, payload, reason='frontend patient updated', hospital_id=user.hospital_id)
    db.commit()
    # Trigger OR optimization to re-assign any new tests
    or_scheduler = ORScheduler(db, hospital_id=user.hospital_id)
    or_scheduler.run_optimization()
    db.commit()
    response = frontend_visit(visit)
    emit_nowait('visit.updated', response)
    emit_nowait('dashboard.metrics.updated', admin_dashboard_payload(db))
    return response


@app.get('/api/visits', response_model=VisitListResponse)
def list_visits(page: int = Query(default=1, ge=1), page_size: int = Query(default=25, ge=1, le=200), search: str | None = None, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return paginated_visits(db, page=page, page_size=page_size, search=search, hospital_id=user.hospital_id)


@app.get('/api/frontend/delta', response_model=DeltaResponse)
def frontend_delta(since: datetime | None = None, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return delta_payload(db, since=since, hospital_id=user.hospital_id)


@app.post('/api/specialists')
async def create_specialist(payload: SpecialistPayload, user: User = Depends(require_role(UserRole.RECEPTIONIST, UserRole.ADMIN, UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    raise HTTPException(status_code=403, detail='Create LabSpecialist users from the role-based user creation flow')


@app.patch('/api/specialists/{specialist_id}')
async def update_specialist(specialist_id: int, payload: SpecialistPayload, user: User = Depends(require_role(UserRole.RECEPTIONIST, UserRole.ADMIN, UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    specialist = db.get(Specialist, specialist_id)
    if specialist is None:
        raise HTTPException(status_code=404, detail='Specialist not found')
    if specialist.hospital_id != user.hospital_id:
        raise HTTPException(status_code=403, detail='Cannot edit another hospital\'s specialist')
    specialist.name = payload.name
    specialist.gender = payload.gender
    specialist.shift_start = datetime.strptime(payload.shift_start[:5], '%H:%M').time()
    specialist.shift_end = datetime.strptime(payload.shift_end[:5], '%H:%M').time()
    specialist.is_active = payload.is_active
    if specialist.user_id:
        linked_user = db.get(User, specialist.user_id)
        if linked_user:
            linked_user.display_name = payload.name
    db.commit()
    # Trigger OR optimization to re-assign based on new specialist availability
    or_scheduler = ORScheduler(db, hospital_id=user.hospital_id)
    or_scheduler.run_optimization()
    db.commit()
    response = frontend_specialist(specialist)
    emit_nowait('specialist.updated', response)
    emit_nowait('dashboard.metrics.updated', admin_dashboard_payload(db))
    return response


@app.delete('/api/specialists/{specialist_id}')
async def delete_specialist(specialist_id: int, user: User = Depends(require_role(UserRole.RECEPTIONIST, UserRole.ADMIN, UserRole.SUPER_ADMIN)), db: Session = Depends(get_db)):
    specialist = db.get(Specialist, specialist_id)
    if specialist is None:
        raise HTTPException(status_code=404, detail='Specialist not found')
    if specialist.hospital_id != user.hospital_id:
        raise HTTPException(status_code=403, detail='Cannot delete another hospital\'s specialist')
    linked_user = db.get(User, specialist.user_id) if specialist.user_id else None
    db.delete(specialist)
    if linked_user:
        db.delete(linked_user)
    db.commit()
    if linked_user:
        try:
            _init_firebase()
            firebase_auth.delete_user(linked_user.firebase_uid)
        except Exception:
            pass
    emit_nowait('specialist.updated', {'id': f's{specialist_id}', 'deleted': True})
    emit_nowait('dashboard.metrics.updated', admin_dashboard_payload(db))
    return {'message': 'Specialist deleted'}


@app.post('/api/labs')
async def create_lab(payload: LabPayload, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    lab = Lab(
        name=payload.name,
        category=payload.category,
        floor=payload.floor,
        room_number=payload.room_number,
        opening_time=datetime.strptime((payload.opening_time or '07:00:00')[:8], '%H:%M:%S').time(),
        closing_time=datetime.strptime((payload.closing_time or '19:00:00')[:8], '%H:%M:%S').time(),
        cleanup_duration_minutes=payload.cleanup_duration_minutes,
        is_active=payload.is_active,
        specialist_id=payload.specialist_id,
        supported_test_codes=[],
        hospital_id=user.hospital_id,
    )
    db.add(lab)
    db.flush()
    # Trigger OR optimization to re-assign tests based on new lab availability
    or_scheduler = ORScheduler(db, hospital_id=user.hospital_id)
    or_scheduler.run_optimization()
    db.commit()
    response = frontend_lab(db, lab)
    emit_nowait('lab.updated', response)
    emit_nowait('dashboard.metrics.updated', admin_dashboard_payload(db))
    return response


@app.post('/api/lab-groups')
async def create_lab_group(payload: LabGroupPayload, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if len(payload.lab_ids) < 2:
        raise HTTPException(status_code=400, detail='At least two labs are required to create a group')

    labs = db.scalars(select(Lab).where(Lab.id.in_(payload.lab_ids))).all()
    if len(labs) != len(set(payload.lab_ids)):
        raise HTTPException(status_code=404, detail='One or more labs were not found')

    categories = {lab.category for lab in labs}
    if len(categories) != 1 or payload.category not in categories:
        raise HTTPException(status_code=400, detail='All labs in a group must belong to the same category')

    already_grouped = [lab.name for lab in labs if lab.group_id is not None]
    if already_grouped:
        raise HTTPException(status_code=400, detail=f'Labs already grouped: {", ".join(already_grouped)}')

    group = LabGroup(name=payload.name, category=payload.category, hospital_id=user.hospital_id)
    db.add(group)
    db.flush()

    for lab in labs:
        lab.group_id = group.id

    db.commit()
    db.refresh(group)
    group = db.scalar(select(LabGroup).where(LabGroup.id == group.id).options(selectinload(LabGroup.labs))) or group
    response = {
        'group': frontend_lab_group(db, group),
        'labs': [frontend_lab(db, lab) for lab in labs],
    }
    emit_nowait('group.updated', response['group'])
    for lab_payload in response['labs']:
        emit_nowait('lab.updated', lab_payload)
    return response


@app.patch('/api/labs/{lab_id}')
async def update_lab(lab_id: int, payload: LabPayload, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    lab = db.get(Lab, lab_id)
    if lab is None:
        raise HTTPException(status_code=404, detail='Lab not found')
    lab.name = payload.name
    lab.category = payload.category
    lab.floor = payload.floor
    lab.room_number = payload.room_number
    lab.is_active = payload.is_active
    lab.specialist_id = payload.specialist_id
    lab.cleanup_duration_minutes = payload.cleanup_duration_minutes
    if payload.opening_time:
        lab.opening_time = datetime.strptime(payload.opening_time[:8], '%H:%M:%S').time()
    if payload.closing_time:
        lab.closing_time = datetime.strptime(payload.closing_time[:8], '%H:%M:%S').time()
    db.commit()
    # Trigger OR optimization to re-assign based on updated lab configuration
    or_scheduler = ORScheduler(db, hospital_id=user.hospital_id)
    or_scheduler.run_optimization()
    db.commit()
    response = frontend_lab(db, lab)
    emit_nowait('lab.updated', response)
    emit_nowait('dashboard.metrics.updated', admin_dashboard_payload(db))
    return response


@app.delete('/api/labs/{lab_id}')
async def delete_lab(lab_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    from app.models import TestStatus, QueueStatus
    lab = db.get(Lab, lab_id)
    if lab is None:
        raise HTTPException(status_code=404, detail='Lab not found')
    affected_tests = db.scalars(select(TestItem).where(TestItem.assigned_lab_id == lab_id, TestItem.status != TestStatus.COMPLETED)).all()
    for test in affected_tests:
        test.assigned_lab_id = None
        test.status = TestStatus.UNSCHEDULABLE
        test.queue_status = QueueStatus.NOT_QUEUED
        test.caution_reason = 'Assigned lab was deleted.'
    db.delete(lab)
    # Use ORScheduler instead of deprecated SchedulingService
    or_scheduler = ORScheduler(db, hospital_id=user.hospital_id)
    or_scheduler.run_optimization()
    db.commit()
    emit_nowait('lab.updated', {'id': f'l{lab_id}', 'deleted': True})
    emit_nowait('dashboard.metrics.updated', admin_dashboard_payload(db))
    return {'message': 'Lab deleted'}


@app.get('/api/labs/{lab_id}/waiting-candidates')
def waiting_candidates(lab_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if db.get(Lab, lab_id) is None:
        raise HTTPException(status_code=404, detail='Lab not found')
    return waiting_candidates_payload(db, lab_id)


@app.get('/api/queues/{lab_id}')
def get_queue(lab_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if db.get(Lab, lab_id) is None:
        raise HTTPException(status_code=404, detail='Lab queue not found')
    return QueueService(db, SchedulingService(db)).snapshot(lab_id)


@app.post('/api/queues/{lab_id}/accept-current')
async def accept_current(lab_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if db.get(Lab, lab_id) is None:
        raise HTTPException(status_code=404, detail='Lab queue not found')
    snapshot = QueueService(db, SchedulingService(db)).accept_current(lab_id)
    db.commit()
    # Trigger OR optimization to immediately fill the NEXT slot
    or_scheduler = ORScheduler(db, hospital_id=user.hospital_id)
    or_scheduler.run_optimization()
    db.commit()
    # Fetch updated snapshot with new NEXT patient
    snapshot = QueueService(db, SchedulingService(db)).snapshot(lab_id)
    emit_nowait('queue.updated', {'labId': f'l{lab_id}', 'snapshot': snapshot})
    return snapshot


@app.post('/api/queues/{lab_id}/move-current-to-pending')
async def move_current_to_pending(lab_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if db.get(Lab, lab_id) is None:
        raise HTTPException(status_code=404, detail='Lab queue not found')
    snapshot = QueueService(db, SchedulingService(db)).move_current_to_pending(lab_id)
    db.commit()
    emit_nowait('queue.updated', {'labId': f'l{lab_id}', 'snapshot': snapshot})
    emit_nowait('dashboard.metrics.updated', admin_dashboard_payload(db))
    return snapshot


@app.post('/api/queues/{lab_id}/move-next-to-pending')
async def move_next_to_pending(lab_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if db.get(Lab, lab_id) is None:
        raise HTTPException(status_code=404, detail='Lab queue not found')
    snapshot = QueueService(db, SchedulingService(db)).move_next_to_pending(lab_id)
    db.commit()
    emit_nowait('queue.updated', {'labId': f'l{lab_id}', 'snapshot': snapshot})
    emit_nowait('dashboard.metrics.updated', admin_dashboard_payload(db))
    return snapshot


@app.post('/api/queues/{lab_id}/accept-from-pending')
async def accept_from_pending(lab_id: int, payload: AcceptPendingPayload | None = None, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if db.get(Lab, lab_id) is None:
        raise HTTPException(status_code=404, detail='Lab queue not found')
    try:
        snapshot = QueueService(db, SchedulingService(db)).accept_from_pending(lab_id, payload.visit_test_id if payload else None)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    db.commit()
    emit_nowait('queue.updated', {'labId': f'l{lab_id}', 'snapshot': snapshot})
    return snapshot


@app.post('/api/queues/{lab_id}/complete-current')
async def complete_current(lab_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if db.get(Lab, lab_id) is None:
        raise HTTPException(status_code=404, detail='Lab queue not found')
    snapshot = QueueService(db, SchedulingService(db)).complete_current(lab_id)
    db.commit()
    # Trigger OR optimization to schedule next tests
    or_scheduler = ORScheduler(db, hospital_id=user.hospital_id)
    or_scheduler.run_optimization()
    db.commit()
    emit_nowait('queue.updated', {'labId': f'l{lab_id}', 'snapshot': snapshot})
    emit_nowait('dashboard.metrics.updated', admin_dashboard_payload(db))
    return snapshot


@app.post('/api/phr-sync/patients')
async def phr_sync_patients(payload: list[VisitPayload], hospital_id: int = Depends(get_lims_hospital), db: Session = Depends(get_db)):
    created: list[str] = []
    for item in payload:
        snapshot = dict(item.patient_snapshot)
        if item.phone:
            snapshot['phone'] = item.phone
        visit = Visit(
            public_id=_next_public_id(db, item.arrival_time),
            phr_reference_id=item.phr_reference_id,
            patient_name=item.patient_name,
            patient_age=item.patient_age,
            patient_gender=item.patient_gender,
            priority_type=item.priority_type,
            phone=item.phone or snapshot.get('phone'),
            arrival_time=item.arrival_time,
            patient_snapshot=snapshot,
            hospital_id=hospital_id,
        )
        db.add(visit)
        db.flush()
        for test_payload in item.tests:
            db.add(TestItem(
                visit_id=visit.id,
                test_code=test_payload['test_code'],
                test_name=test_payload['test_name'],
                category=test_payload['category'],
                duration_minutes=int(test_payload.get('duration_minutes', 10)),
                tags=list(test_payload.get('tags', [])),
                condition_category=test_payload.get('condition_category'),
                status=TestStatus.SCHEDULED,
                queue_status=QueueStatus.WAITING,
                hospital_id=hospital_id,
            ))
        db.flush()
        created.append(visit.public_id)
    db.commit()
    or_scheduler = ORScheduler(db, hospital_id=hospital_id)
    or_scheduler.run_optimization()
    db.commit()
    emit_nowait('visit.updated', {'created': created})
    emit_nowait('dashboard.metrics.updated', admin_dashboard_payload(db))
    return {'created': created}


@app.post('/api/scheduling/run')
async def run_scheduling(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    or_scheduler = ORScheduler(db, hospital_id=user.hospital_id)
    result = or_scheduler.run_optimization()
    db.commit()
    emit_nowait('dashboard.metrics.updated', admin_dashboard_payload(db))
    return {'message': 'Scheduling refreshed', 'result': result}


# ===== OR Scheduler Endpoints =====
@app.post('/api/or/optimize')
async def run_or_optimization(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Run OR-Tools optimization to assign tests to labs."""
    or_scheduler = ORScheduler(db, hospital_id=user.hospital_id)
    result = or_scheduler.run_optimization()
    emit_nowait('dashboard.metrics.updated', admin_dashboard_payload(db))
    return result


@app.get('/api/or/schedule-preview')
async def get_or_schedule_preview(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Preview optimal assignments without applying them."""
    or_scheduler = ORScheduler(db, hospital_id=user.hospital_id)
    assignments = or_scheduler.optimize_schedule()
    return {
        'assignments_count': len(assignments),
        'assignments': assignments,
        'timestamp': datetime.now().isoformat()
    }


# ===== Planning Poker Endpoints =====
@app.post('/api/planning-poker/sessions')
async def create_poker_session(
    item_type: str,
    item_id: str,
    item_name: str,
    description: str = '',
    db: Session = Depends(get_db)
):
    """Create a new Planning Poker estimation session."""
    service = PlanningPokerService(db)
    session = service.create_session(item_type, item_id, item_name, description)
    return {
        'session_id': session.id,
        'item_type': session.item_type,
        'item_name': session.item_name,
        'status': session.status,
        'fibonacci_sequence': service.FIBONACCI_SEQUENCE
    }


@app.get('/api/planning-poker/sessions')
async def list_poker_sessions(status: VotingStatus | None = None):
    """List all Planning Poker sessions."""
    sessions = PlanningPokerService.list_sessions(status)
    return [
        {
            'session_id': s.id,
            'item_type': s.item_type,
            'item_name': s.item_name,
            'status': s.status,
            'participants': len(s.votes),
            'created_at': s.created_at.isoformat()
        }
        for s in sessions
    ]


@app.post('/api/planning-poker/sessions/{session_id}/join')
async def join_poker_session(session_id: str, user_id: str, username: str, db: Session = Depends(get_db)):
    """Join a Planning Poker session."""
    service = PlanningPokerService(db)
    try:
        session = service.join_session(session_id, user_id, username)
        return {
            'session_id': session.id,
            'status': session.status,
            'participants': [
                {'user_id': v.user_id, 'username': v.username, 'voted': v.value is not None}
                for v in session.votes.values()
            ]
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post('/api/planning-poker/sessions/{session_id}/vote')
async def cast_poker_vote(session_id: str, user_id: str, value: int, db: Session = Depends(get_db)):
    """Cast a vote in a Planning Poker session."""
    service = PlanningPokerService(db)
    try:
        session = service.cast_vote(session_id, user_id, value)
        return {
            'session_id': session.id,
            'your_vote': value,
            'total_votes': len([v for v in session.votes.values() if v.value is not None]),
            'total_participants': len(session.votes)
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post('/api/planning-poker/sessions/{session_id}/reveal')
async def reveal_poker_votes(session_id: str, db: Session = Depends(get_db)):
    """Reveal all votes in a Planning Poker session."""
    service = PlanningPokerService(db)
    try:
        session = service.reveal_votes(session_id)
        votes = [v.value for v in session.votes.values() if v.value is not None]
        return {
            'session_id': session.id,
            'votes': [
                {'username': v.username, 'value': v.value}
                for v in session.votes.values()
            ],
            'stats': service.get_session_stats(session_id)
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post('/api/planning-poker/sessions/{session_id}/complete')
async def complete_poker_session(session_id: str, db: Session = Depends(get_db)):
    """Complete a Planning Poker session and calculate consensus."""
    service = PlanningPokerService(db)
    try:
        session = service.complete_session(session_id)
        return {
            'session_id': session.id,
            'status': session.status,
            'final_value': session.final_value,
            'completed_at': session.completed_at.isoformat() if session.completed_at else None
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get('/api/planning-poker/sessions/{session_id}/stats')
async def get_poker_session_stats(session_id: str, db: Session = Depends(get_db)):
    """Get statistics for a Planning Poker session."""
    service = PlanningPokerService(db)
    try:
        return service.get_session_stats(session_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ==========================================
# RE-INTEGRATED: REACT UI ENDPOINTS
# ==========================================

@app.get('/api/lobby/next')
def get_next_patients(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Get patients waiting for next test assignment (lobby optimization candidates)."""
    from app.models import TestItem, TestStatus, QueueStatus
    # Run OR optimization to ensure queue is up-to-date
    or_scheduler = ORScheduler(db, hospital_id=user.hospital_id)
    or_scheduler.run_optimization()
    # Return tests that are waiting for assignment
    waiting_tests = db.scalars(
        select(TestItem)
        .where(
            TestItem.status == TestStatus.SCHEDULED,
            TestItem.queue_status == QueueStatus.WAITING
        )
        .options(selectinload(TestItem.visit))
    ).all()
    return [
        {
            'test_id': t.id,
            'test_name': t.test_name,
            'test_code': t.test_code,
            'visit_id': t.visit_id,
            'patient_name': t.visit.patient_name,
            'patient_id': t.visit.public_id,
            'assigned_lab_id': t.assigned_lab_id,
            'status': t.queue_status.value
        }
        for t in waiting_tests
    ]


@app.get('/api/lobby/pending')
def get_pending_patients(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Get patients in pending state (paused/blocked tests)."""
    from app.models import TestItem, QueueStatus
    pending_tests = db.scalars(
        select(TestItem)
        .where(TestItem.queue_status == QueueStatus.PENDING)
        .options(selectinload(TestItem.visit))
    ).all()
    return [
        {
            'test_id': t.id,
            'test_name': t.test_name,
            'test_code': t.test_code,
            'visit_id': t.visit_id,
            'patient_name': t.visit.patient_name,
            'patient_id': t.visit.public_id,
            'assigned_lab_id': t.assigned_lab_id,
            'status': t.queue_status.value
        }
        for t in pending_tests
    ]


@app.get('/api/labs/{lab_id}/current')
def get_current_patient_in_lab(lab_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Get the patient currently being processed in a lab."""
    from app.models import TestItem, QueueStatus
    test = db.scalar(
        select(TestItem)
        .where(
            TestItem.assigned_lab_id == lab_id,
            TestItem.queue_status == QueueStatus.CURRENT
        )
        .options(selectinload(TestItem.visit))
    )
    if not test:
        raise HTTPException(status_code=404, detail='No patient currently in this lab')
    return {
        'test_id': test.id,
        'test_name': test.test_name,
        'test_code': test.test_code,
        'visit_id': test.visit_id,
        'patient_name': test.visit.patient_name,
        'patient_id': test.visit.public_id,
        'status': test.queue_status.value
    }


@app.post('/api/tests/{test_id}/start')
def start_test(test_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Mark a test as in-progress (specialist started working on it)."""
    from app.models import TestItem, TestStatus, QueueStatus
    test = db.get(TestItem, test_id)
    if not test:
        raise HTTPException(status_code=404, detail='Test not found')
    test.status = TestStatus.IN_PROGRESS
    test.queue_status = QueueStatus.CURRENT
    test.started_at = datetime.now(timezone.utc)
    db.commit()
    return {
        'test_id': test.id,
        'status': test.status.value,
        'queue_status': test.queue_status.value
    }


@app.post('/api/tests/{test_id}/complete')
def complete_test(test_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    from app.models import CompletedTestSnapshot
    from app.services.patient_ids import patient_id_date
    from app.services.lims_webhook import fire_test_completed_webhook

    test = db.scalar(
        select(TestItem).where(TestItem.id == test_id).options(selectinload(TestItem.visit))
    )
    if not test:
        raise HTTPException(status_code=404, detail='Test not found')

    completed_at = datetime.now(timezone.utc)
    test.status = TestStatus.COMPLETED
    test.queue_status = QueueStatus.DONE
    test.completed_at = completed_at

    db.add(CompletedTestSnapshot(
        snapshot_date=patient_id_date(completed_at),
        patient_public_id=test.visit.public_id,
        patient_name=test.visit.patient_name,
        visit_id=test.visit.id,
        test_item_id=test.id,
        test_name=test.test_name,
        completed_at=completed_at,
        lab_id=test.assigned_lab_id,
        lab_name=test.assigned_lab.name if test.assigned_lab else None,
    ))

    queue_entry = db.scalar(select(QueueEntry).where(QueueEntry.test_item_id == test_id))
    if queue_entry:
        db.delete(queue_entry)

    db.commit()
    fire_test_completed_webhook(test.hospital_id, test.visit, test)
    return {
        'test_id': test.id,
        'status': test.status.value,
        'queue_status': test.queue_status.value,
        'completed_at': completed_at.isoformat()
    }


@app.post('/api/tests/{test_id}/unblock')
def unblock_test(test_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Unblock a test and return it to NOT_QUEUED so OR-Solver can route it."""
    from app.models import TestItem, TestStatus, QueueStatus
    test = db.get(TestItem, test_id)
    if not test:
        raise HTTPException(status_code=404, detail='Test not found')

    test.status = TestStatus.SCHEDULED
    # CRITICAL FIX: Changed from WAITING to NOT_QUEUED
    test.queue_status = QueueStatus.NOT_QUEUED
    test.caution_reason = None
    db.commit()

    # Run OR optimization to re-assign
    or_scheduler = ORScheduler(db, hospital_id=user.hospital_id)
    or_scheduler.run_optimization()

    return {
        'test_id': test.id,
        'status': test.status.value,
        'queue_status': test.queue_status.value
    }


@app.post('/api/tests/{test_id}/pending')
def specialist_push_to_pending(test_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Push a test to pending state (specialist needs patient to wait)."""
    from app.models import TestItem, TestStatus, QueueStatus, QueueEntry, QueueEntryType
    from datetime import datetime, timezone

    test = db.get(TestItem, test_id)
    if not test:
        raise HTTPException(status_code=404, detail='Test not found')

    test.status = TestStatus.SCHEDULED
    test.queue_status = QueueStatus.PENDING

    # Update or create queue entry
    queue_entry = db.scalar(select(QueueEntry).where(QueueEntry.test_item_id == test_id))
    if queue_entry:
        queue_entry.queue_type = QueueEntryType.PENDING
        queue_entry.pending_since = datetime.now(timezone.utc)
    else:
        db.add(QueueEntry(
            test_item_id=test_id,
            visit_id=test.visit_id,
            lab_id=test.assigned_lab_id,
            queue_type=QueueEntryType.PENDING,
            pending_since=datetime.now(timezone.utc)
        ))

    db.commit()
    return {
        'test_id': test.id,
        'status': test.status.value,
        'queue_status': test.queue_status.value
    }


@app.post('/api/visits/{visit_id}/block')
def receptionist_block_visit(visit_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Block all tests in a visit (receptionist action) - blocks without locking to a lab."""
    from app.models import TestItem, TestStatus
    tests = db.scalars(select(TestItem).where(TestItem.visit_id == visit_id)).all()
    for test in tests:
        if test.status not in {TestStatus.COMPLETED, TestStatus.IN_PROGRESS}:
            test.is_blocked = True
            test.caution_reason = 'Visit blocked by receptionist'
    db.commit()
    return {'message': 'Visit blocked', 'visit_id': visit_id}


@app.post('/api/visits/{visit_id}/unblock')
def receptionist_unblock_visit(visit_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Unblock all tests in a visit (receptionist action) - re-considers for scheduling."""
    from app.models import TestItem, TestStatus, QueueStatus
    tests = db.scalars(select(TestItem).where(TestItem.visit_id == visit_id)).all()
    for test in tests:
        if test.is_blocked:
            test.is_blocked = False
            test.caution_reason = None
            # Reset to WAITING so OR-Solver can re-assign to correct lab
            if test.queue_status != QueueStatus.CURRENT and test.status != TestStatus.IN_PROGRESS:
                test.queue_status = QueueStatus.WAITING
    db.commit()
    # Run OR optimization to re-assign
    or_scheduler = ORScheduler(db, hospital_id=user.hospital_id)
    or_scheduler.run_optimization()
    return {'message': 'Visit unblocked', 'visit_id': visit_id}


@app.get('/api/frontend/visits')
def get_frontend_visits(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Get all visits for the frontend Patient Records table."""
    from app.models import TestItem
    stmt = select(Visit).options(selectinload(Visit.tests))
    if user.hospital_id:
        stmt = stmt.where(Visit.hospital_id == user.hospital_id)
    visits = db.scalars(stmt).all()
    result = []
    for v in visits:
        test_names = [t.test_name for t in v.tests]
        # Determine status based on tests
        if any(t.status == TestStatus.IN_PROGRESS for t in v.tests):
            status = 'In Progress'
        elif all(t.status == TestStatus.COMPLETED for t in v.tests):
            status = 'Completed'
        elif any(t.is_blocked for t in v.tests):
            status = 'Blocked'
        elif any(t.queue_status == QueueStatus.PENDING for t in v.tests):
            status = 'Pending'
        else:
            status = 'Waiting'

        result.append({
            'id': v.public_id,
            'visit_id': v.id,
            'patient_name': v.patient_name,
            'patient_age': v.patient_age,
            'patient_gender': v.patient_gender,
            'phone': v.phone or 'N/A',
            'priority_type': v.priority_type,
            'status': status,
            'arrival_time': v.arrival_time.isoformat(),
            'tests': test_names
        })
    return result


@app.post('/api/lims/ingest')
async def ingest_patient_from_lims(request: Request, hospital_id: int = Depends(get_lims_hospital), db: Session = Depends(get_db)):
    payload = await request.json()
    catalog = hospital_catalog_map(db, hospital_id)

    visit = Visit(
        public_id=_next_public_id(db, datetime.now()),
        phr_reference_id=payload.get('lims_patient_id') or f'LIMS-{datetime.now().strftime("%Y%m%d%H%M%S%f")}',
        patient_name=payload.get('patient_name', 'Unknown'),
        patient_age=payload.get('patient_age', 30),
        patient_gender=payload.get('gender', 'Any'),
        priority_type=payload.get('priority_type', 'Routine'),
        arrival_time=datetime.now().astimezone(),
        patient_snapshot={},
        hospital_id=hospital_id,
    )
    db.add(visit)
    db.flush()

    tests_list = payload.get('requested_tests', payload.get('tests', []))
    for test_payload in tests_list:
        test_code = test_payload.get('test_id') or test_payload.get('test_code')
        test_name = test_payload.get('test_name')

        item = None
        if test_code:
            for v in catalog.values():
                if v['test_code'] == test_code:
                    item = v
                    break
        elif test_name and test_name in catalog:
            item = catalog[test_name]

        if item:
            db.add(TestItem(
                visit_id=visit.id,
                test_code=item['test_code'],
                test_name=item['test_name'],
                category=item['category'],
                duration_minutes=int(item['duration_minutes']),
                tags=list(item.get('tags', [])),
                status=TestStatus.SCHEDULED,
                queue_status=QueueStatus.WAITING,
                hospital_id=hospital_id,
            ))

    db.commit()
    or_scheduler = ORScheduler(db, hospital_id=hospital_id)
    or_scheduler.run_optimization()
    db.commit()
    emit_nowait('visit.updated', {'public_id': visit.public_id})
    return {
        'visit_id': visit.id,
        'public_id': visit.public_id,
        'message': 'Patient ingested successfully',
    }


# ===== LIMS Status Endpoints (API key auth) =====

@app.get('/api/lims/visit/{phr_reference_id}/status')
def lims_visit_status(phr_reference_id: str, hospital_id: int = Depends(get_lims_hospital), db: Session = Depends(get_db)):
    visit = db.scalar(
        select(Visit)
        .where(Visit.phr_reference_id == phr_reference_id, Visit.hospital_id == hospital_id)
        .options(selectinload(Visit.tests))
    )
    if not visit:
        raise HTTPException(status_code=404, detail='Visit not found')
    return {
        'phr_reference_id': visit.phr_reference_id,
        'public_id': visit.public_id,
        'patient_name': visit.patient_name,
        'arrival_time': visit.arrival_time.isoformat(),
        'tests': [
            {
                'test_code': t.test_code, 'test_name': t.test_name,
                'status': t.status.value, 'queue_status': t.queue_status.value,
                'assigned_lab_id': t.assigned_lab_id,
                'allocated_at': t.allocated_at.isoformat() if t.allocated_at else None,
                'started_at': t.started_at.isoformat() if t.started_at else None,
                'completed_at': t.completed_at.isoformat() if t.completed_at else None,
            }
            for t in visit.tests
        ],
    }


@app.post('/api/lims/visits/status')
def lims_bulk_visit_status(payload: dict, hospital_id: int = Depends(get_lims_hospital), db: Session = Depends(get_db)):
    phr_ids = payload.get('phr_reference_ids', [])
    visits = db.scalars(
        select(Visit)
        .where(Visit.phr_reference_id.in_(phr_ids), Visit.hospital_id == hospital_id)
        .options(selectinload(Visit.tests))
    ).all()
    return [
        {
            'phr_reference_id': v.phr_reference_id,
            'public_id': v.public_id,
            'patient_name': v.patient_name,
            'arrival_time': v.arrival_time.isoformat(),
            'tests': [
                {
                    'test_code': t.test_code, 'test_name': t.test_name,
                    'status': t.status.value, 'queue_status': t.queue_status.value,
                    'assigned_lab_id': t.assigned_lab_id,
                    'allocated_at': t.allocated_at.isoformat() if t.allocated_at else None,
                    'started_at': t.started_at.isoformat() if t.started_at else None,
                    'completed_at': t.completed_at.isoformat() if t.completed_at else None,
                }
                for t in v.tests
            ],
        }
        for v in visits
    ]


# ===== Demo Data Seed Endpoints (For Development/Demo) =====
@app.post('/api/seed/lims-patients')
async def seed_lims_patients(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Seed patients from VISIT_TEMPLATES using PHR sync format."""
    from app.seed_data import VISIT_TEMPLATES
    
    created: list[str] = []
    catalog = test_catalog_map()
    
    for template in VISIT_TEMPLATES:
        # Skip if duplicate PHR reference already exists
        existing = db.scalar(
            select(Visit).where(Visit.phr_reference_id == template['phr_reference_id'])
        )
        if existing:
            continue
            
        # Build arrival time (today + template arrival_clock)
        now = datetime.now().astimezone()
        arrival_parts = template['arrival_clock'].split(':')
        arrival_time = now.replace(hour=int(arrival_parts[0]), minute=int(arrival_parts[1]), second=0, microsecond=0)
        
        snapshot = dict(template.get('patient_snapshot', {}))
        phone = snapshot.get('phone', '')
        
        visit = Visit(
            public_id=_next_public_id(db, arrival_time),
            phr_reference_id=template['phr_reference_id'],
            patient_name=template['patient_name'],
            patient_age=template['patient_age'],
            patient_gender=template['patient_gender'],
            priority_type=template['priority_type'],
            phone=phone or None,
            arrival_time=arrival_time,
            patient_snapshot=snapshot,
        )
        db.add(visit)
        db.flush()
        
        for test in template['tests']:
            db.add(TestItem(
                visit_id=visit.id,
                test_code=test['test_code'],
                test_name=test['test_name'],
                category=test['category'],
                duration_minutes=int(test.get('duration_minutes', 10)),
                tags=list(test.get('tags', [])),
                condition_category=test.get('condition_category'),
                status=TestStatus.SCHEDULED,
                queue_status=QueueStatus.WAITING,
            ))
        db.flush()
        created.append(visit.public_id)
    
    db.commit()
    
    # Run OR optimization for all new patients
    or_scheduler = ORScheduler(db, hospital_id=user.hospital_id)
    or_scheduler.run_optimization()
    db.commit()
    
    emit_nowait('dashboard.metrics.updated', admin_dashboard_payload(db))
    return {
        'created_count': len(created),
        'created': created,
        'message': f'{len(created)} LIMS patients seeded successfully'
    }


@app.post('/api/seed/specialists')
async def seed_mock_specialists(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Seed mock specialists from DEFAULT_SPECIALISTS."""
    from app.seed_data import DEFAULT_SPECIALISTS
    from datetime import time
    
    created: list[dict] = []
    
    for specialist_data in DEFAULT_SPECIALISTS:
        # Check if specialist with same name already exists
        existing = db.scalar(
            select(Specialist).where(Specialist.name == specialist_data['name'])
        )
        if existing:
            continue
        
        specialist = Specialist(
            name=specialist_data['name'],
            gender=specialist_data['gender'],
            shift_start=specialist_data['shift_start'],
            shift_end=specialist_data['shift_end'],
            is_active=True,
        )
        db.add(specialist)
        db.flush()
        created.append({
            'id': f's{specialist.id}',
            'name': specialist.name,
            'gender': specialist.gender,
        })
    
    db.commit()
    
    for item in created:
        emit_nowait('specialist.updated', item)
    
    emit_nowait('dashboard.metrics.updated', admin_dashboard_payload(db))
    
    return {
        'created_count': len(created),
        'created': created,
        'message': f'{len(created)} mock specialists seeded successfully'
    }


@app.post('/api/seed/labs')
async def seed_mock_labs(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Seed mock labs from DEFAULT_LABS."""
    from app.seed_data import DEFAULT_LABS
    
    created: list[dict] = []
    
    # Get all specialists first
    specialists = db.scalars(select(Specialist)).all()
    specialist_dict = {i: spec for i, spec in enumerate(specialists, 1)}
    
    for lab_data in DEFAULT_LABS:
        # Check if lab with same name already exists
        existing = db.scalar(
            select(Lab).where(Lab.name == lab_data['name'])
        )
        if existing:
            continue
        
        # Get specialist based on index
        specialist_index = lab_data.get('specialist_index', 1)
        specialist_id = specialist_dict.get(specialist_index).id if specialist_index in specialist_dict else None
        
        lab = Lab(
            name=lab_data['name'],
            category=lab_data['category'],
            floor=lab_data['floor'],
            room_number=lab_data['room_number'],
            specialist_id=specialist_id,
            is_active=lab_data['is_active'],
            opening_time=lab_data['opening_time'],
            closing_time=lab_data['closing_time'],
            cleanup_duration_minutes=lab_data['cleanup_duration_minutes'],
            supported_test_codes=lab_data.get('supported_test_codes', []),
        )
        db.add(lab)
        db.flush()
        created.append({
            'id': f'l{lab.id}',
            'name': lab.name,
            'category': lab.category,
            'floor': lab.floor,
        })
    
    db.commit()
    
    # Trigger OR optimization for new labs
    or_scheduler = ORScheduler(db, hospital_id=user.hospital_id)
    or_scheduler.run_optimization()
    db.commit()
    
    for item in created:
        emit_nowait('lab.updated', item)
    
    emit_nowait('dashboard.metrics.updated', admin_dashboard_payload(db))
    
    return {
        'created_count': len(created),
        'created': created,
        'message': f'{len(created)} mock labs seeded successfully'
    }


asgi_app = mount(app)

# CORS must be added on the outer ASGI app so headers are present
# even on responses that pass through the Socket.IO layer.
from starlette.middleware.cors import CORSMiddleware as _CM
application = _CM(
    asgi_app,
    allow_origins=['*'] if settings.allow_all_cors_origins else list(settings.cors_origins),
    allow_origin_regex=settings.cors_origin_regex,
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)
