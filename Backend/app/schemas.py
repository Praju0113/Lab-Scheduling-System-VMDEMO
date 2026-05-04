from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class SpecialistPayload(BaseModel):
    name: str
    gender: str
    shift_start: str
    shift_end: str
    is_active: bool = True


class LabPayload(BaseModel):
    name: str
    category: str
    floor: str
    room_number: str | None = None
    opening_time: str | None = None
    closing_time: str | None = None
    cleanup_duration_minutes: int = 0
    is_active: bool = True
    specialist_id: int | None = None


class LabGroupPayload(BaseModel):
    name: str
    category: str
    lab_ids: list[int] = Field(default_factory=list)


class VisitPayload(BaseModel):
    phr_reference_id: str
    patient_name: str
    patient_age: int
    patient_gender: str
    priority_type: str
    phone: str | None = None
    arrival_time: datetime
    patient_snapshot: dict[str, Any] = Field(default_factory=dict)
    tests: list[dict[str, Any]]


class FrontendPatientTestPayload(BaseModel):
    test_name: str
    priority_flag: str = 'NONE'


class FrontendPatientPayload(BaseModel):
    patient_name: str
    patient_age: int
    patient_gender: str
    priority_type: str = 'NORMAL'
    phone: str = ''
    test_names: list[str] = Field(default_factory=list)
    test_details: list[FrontendPatientTestPayload] = Field(default_factory=list)


class AcceptPendingPayload(BaseModel):
    visit_test_id: int | None = None


class VisitListResponse(BaseModel):
    items: list[dict[str, Any]]
    total: int
    page: int
    page_size: int
    has_more: bool


class DeltaResponse(BaseModel):
    since: datetime | None = None
    now: datetime
    visits: list[dict[str, Any]]
    labs: list[dict[str, Any]]
    groups: list[dict[str, Any]]
    specialists: list[dict[str, Any]]
    metrics: dict[str, Any]


class LoginPayload(BaseModel):
    firebase_token: str


class CreateHospitalPayload(BaseModel):
    name: str
    code: str


class CreateUserPayload(BaseModel):
    email: str
    password: str
    display_name: str
    role: str
    hospital_id: int | None = None


class HospitalTestCatalogEntry(BaseModel):
    test_code: str
    test_name: str
    category: str
    duration_minutes: int
    tags: list[str] = Field(default_factory=list)
    condition_category: str | None = None
    is_active: bool = True


class HospitalTestCatalogBulkImport(BaseModel):
    test_codes: list[str]


class HospitalTestCatalogUpdate(BaseModel):
    duration_minutes: int | None = None
    is_active: bool | None = None


class ExplicitDependencyPayload(BaseModel):
    test_code: str
    depends_on_test_code: str
    dependency_type: str = 'must_complete_before'
    is_strict: bool = True


class LimsConfigPayload(BaseModel):
    callback_url: str | None = None
    is_enabled: bool = False


class LimsTestStatusResponse(BaseModel):
    test_code: str
    test_name: str
    status: str
    queue_status: str
    assigned_lab_id: int | None = None
    allocated_at: datetime | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None


class LimsVisitStatusResponse(BaseModel):
    phr_reference_id: str
    public_id: str
    patient_name: str
    arrival_time: datetime
    tests: list[LimsTestStatusResponse]


class LimsBulkStatusPayload(BaseModel):
    phr_reference_ids: list[str]
