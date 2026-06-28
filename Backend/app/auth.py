from __future__ import annotations

import hashlib
import os
import secrets
from functools import lru_cache
from pathlib import Path

import firebase_admin
import jwt
from firebase_admin import auth as firebase_auth, credentials
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_db
from app.models import Hospital, LimsConfig, User, UserRole

_bearer = HTTPBearer(auto_error=False)

_SERVICE_ACCOUNT_PATH = Path(__file__).resolve().parent.parent / 'firebase-service-account.json'


@lru_cache(maxsize=1)
def _init_firebase() -> firebase_admin.App:
    try:
        return firebase_admin.get_app()
    except ValueError:
        if _SERVICE_ACCOUNT_PATH.exists():
            cred = credentials.Certificate(str(_SERVICE_ACCOUNT_PATH))
        elif os.environ.get('GOOGLE_APPLICATION_CREDENTIALS'):
            cred = credentials.Certificate(os.environ['GOOGLE_APPLICATION_CREDENTIALS'])
        else:
            cred = credentials.ApplicationDefault()
        try:
            return firebase_admin.initialize_app(cred, {'projectId': settings.firebase_project_id})
        except ValueError:
            # Race condition: another thread initialized the app between get_app() and initialize_app()
            return firebase_admin.get_app()


_CLOCK_SKEW_SECONDS = 60


def verify_firebase_token(id_token: str) -> dict:
    import logging as _logging
    import time as _time
    _log = _logging.getLogger('auth_debug')
    _init_firebase()
    try:
        return firebase_auth.verify_id_token(id_token, check_revoked=False)
    except firebase_auth.InvalidIdTokenError as e:
        err_msg = str(e)
        _log.error('InvalidIdTokenError: %s', err_msg)
        # Handle clock skew: "Token used too early" means local clock is behind
        if 'too early' in err_msg.lower():
            _log.warning('Clock skew detected, retrying with %ds leeway', _CLOCK_SKEW_SECONDS)
            try:
                # Decode without signature verification but with audience + expiry leeway
                decoded = jwt.decode(
                    id_token,
                    options={'verify_signature': False, 'verify_exp': True, 'verify_aud': True},
                    audience=settings.firebase_project_id,
                    algorithms=['RS256'],
                    leeway=_CLOCK_SKEW_SECONDS,
                )
                # PyJWT returns raw claims where uid is in 'sub'; Firebase Admin SDK
                # normally maps sub → uid, so we do the same here.
                if 'uid' not in decoded and 'sub' in decoded:
                    decoded['uid'] = decoded['sub']
                return decoded
            except Exception as jwt_e:
                _log.error('JWT decode with leeway failed: %s', jwt_e)
        # Fallback for cross-project tokens
        try:
            unverified = jwt.decode(
                id_token,
                options={'verify_signature': False, 'verify_exp': False, 'verify_aud': False},
                algorithms=['RS256'],
            )
            fallback_project_id = str(unverified.get('aud', '')).strip()
            _log.error('Token aud=%s, settings.firebase_project_id=%s', fallback_project_id, settings.firebase_project_id)
            if not fallback_project_id or fallback_project_id == settings.firebase_project_id:
                raise

            app_name = f'firebase:{fallback_project_id}'
            try:
                fallback_app = firebase_admin.get_app(app_name)
            except ValueError:
                if _SERVICE_ACCOUNT_PATH.exists():
                    fallback_cred = credentials.Certificate(str(_SERVICE_ACCOUNT_PATH))
                elif os.environ.get('GOOGLE_APPLICATION_CREDENTIALS'):
                    fallback_cred = credentials.Certificate(os.environ['GOOGLE_APPLICATION_CREDENTIALS'])
                else:
                    fallback_cred = credentials.ApplicationDefault()
                fallback_app = firebase_admin.initialize_app(
                    fallback_cred,
                    {'projectId': fallback_project_id},
                    name=app_name,
                )
            return firebase_auth.verify_id_token(id_token, app=fallback_app, check_revoked=False)
        except Exception as inner_e:
            _log.error('Fallback verification also failed: %s', inner_e)
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Invalid token')
    except firebase_auth.RevokedIdTokenError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Token revoked')
    except Exception as e:
        _log.error('Token verification failed: %s', e)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Token verification failed')


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    if creds is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Missing authorization header')

    token = creds.credentials
    decoded = verify_firebase_token(token)
    uid = decoded.get('uid')
    if not uid:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Invalid token payload')

    user = db.scalar(select(User).where(User.firebase_uid == uid, User.is_active == True))
    if not user:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail='User not registered in system')
    if user.role != UserRole.SUPER_ADMIN and user.hospital_id:
        hospital = db.get(Hospital, user.hospital_id)
        if hospital and not hospital.is_active:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail='Hospital is disabled')

    return user


def require_role(*roles: UserRole):
    def dependency(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail='Insufficient permissions')
        return user
    return dependency


def create_firebase_user(email: str, password: str, display_name: str) -> str:
    _init_firebase()
    fb_user = firebase_auth.create_user(email=email, password=password, display_name=display_name)
    return fb_user.uid


def update_firebase_user(
    uid: str,
    *,
    email: str | None = None,
    password: str | None = None,
    display_name: str | None = None,
) -> None:
    _init_firebase()
    kwargs: dict[str, str] = {}
    if email is not None:
        kwargs['email'] = email
    if password:
        kwargs['password'] = password
    if display_name is not None:
        kwargs['display_name'] = display_name
    if kwargs:
        firebase_auth.update_user(uid, **kwargs)


def generate_api_key() -> tuple[str, str]:
    plaintext = secrets.token_urlsafe(48)
    hashed = hashlib.sha256(plaintext.encode()).hexdigest()
    return plaintext, hashed


def get_lims_hospital(
    request: Request,
    db: Session = Depends(get_db),
) -> int:
    api_key = request.headers.get('X-API-Key')
    if not api_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Missing X-API-Key header')
    key_hash = hashlib.sha256(api_key.encode()).hexdigest()
    config = db.scalar(
        select(LimsConfig).where(LimsConfig.api_key_hash == key_hash, LimsConfig.is_enabled == True)
    )
    if not config:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Invalid or disabled API key')
    return config.hospital_id
