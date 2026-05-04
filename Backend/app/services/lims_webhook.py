from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.models import LimsConfig, LimsWebhookLog, TestItem, Visit

logger = logging.getLogger(__name__)


def _build_completion_payload(visit: Visit, test: TestItem) -> dict:
    return {
        'event': 'test.completed',
        'phr_reference_id': visit.phr_reference_id,
        'public_id': visit.public_id,
        'patient_name': visit.patient_name,
        'test_code': test.test_code,
        'test_name': test.test_name,
        'allocated_at': test.allocated_at.isoformat() if test.allocated_at else None,
        'started_at': test.started_at.isoformat() if test.started_at else None,
        'completed_at': test.completed_at.isoformat() if test.completed_at else None,
        'assigned_lab_id': test.assigned_lab_id,
        'timestamp': datetime.now(timezone.utc).isoformat(),
    }


async def _send_webhook(hospital_id: int, payload: dict) -> None:
    with SessionLocal() as db:
        config = db.scalar(
            select(LimsConfig).where(
                LimsConfig.hospital_id == hospital_id,
                LimsConfig.is_enabled == True,
            )
        )
        if not config or not config.callback_url:
            return

        status_code = None
        response_body = None
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(config.callback_url, json=payload)
                status_code = resp.status_code
                response_body = resp.text[:2000]
        except Exception as exc:
            status_code = 0
            response_body = str(exc)[:2000]
            logger.warning('LIMS webhook failed for hospital %s: %s', hospital_id, exc)

        db.add(LimsWebhookLog(
            hospital_id=hospital_id,
            event_type=payload.get('event', 'unknown'),
            payload=payload,
            status_code=status_code,
            response_body=response_body,
        ))
        db.commit()


def fire_test_completed_webhook(hospital_id: int | None, visit: Visit, test: TestItem) -> None:
    if hospital_id is None:
        return
    payload = _build_completion_payload(visit, test)
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_send_webhook(hospital_id, payload))
    except RuntimeError:
        asyncio.run(_send_webhook(hospital_id, payload))
