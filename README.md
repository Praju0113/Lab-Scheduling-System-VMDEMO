# Lab Scheduling System - Technical Documentation

## Overview

The Lab Scheduling System is a comprehensive healthcare queue management platform that uses **Operations Research (OR)** optimization and **Planning Poker** collaborative estimation to efficiently route patients through medical laboratory tests.

## Key Features

- **OR-Tools CP-SAT Solver**: Mathematical optimization for patient-to-lab assignments
- **Planning Poker**: Collaborative estimation for test duration forecasting
- **Real-time Queue Management**: Dynamic patient flow with live updates via Socket.IO
- **Dependency Resolution**: Automatic handling of test prerequisites (e.g., ECG before TMT)
- **Multi-dashboard Support**: Receptionist, Specialist, Admin, and SuperAdmin views
- **Firebase Authentication**: Secure login with role-based access control
- **Multi-hospital Support**: Hospital-scoped data isolation with a global SuperAdmin role
- **LIMS Integration**: Webhook-based ingestion from external Laboratory Information Systems

---

## System Architecture

### Backend Stack
- **Framework**: FastAPI (Python 3.11+)
- **Database**: PostgreSQL 16 with SQLAlchemy ORM
- **Auth**: Firebase Admin SDK + Firebase Auth (client-side)
- **Optimization Engine**: Google OR-Tools CP-SAT solver
- **Real-time**: Socket.IO (python-socketio) for live updates
- **Containerization**: Docker & Docker Compose

### Frontend Stack
- **Framework**: React 18 + TypeScript
- **Build Tool**: Vite
- **Styling**: TailwindCSS
- **UI Components**: shadcn/ui + Radix UI
- **Icons**: Lucide React
- **State Management**: Zustand
- **Data Fetching**: Axios with interceptors
- **Auth**: Firebase Auth (client SDK)

---

## Quick Start

### Prerequisites
- **PostgreSQL 16+** (local or Docker)
- **Python 3.11+** (with venv/conda)
- **Node.js 20+** (with npm)
- **Firebase project** with Authentication enabled

### 1. Environment Setup

Copy `.env.example` to `.env` and configure:

```env
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=lab_scheduling
POSTGRES_PORT=5433

BACKEND_PORT=8001
FRONTEND_PORT=5174

DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5433/lab_scheduling
BACKEND_CORS_ORIGINS=http://localhost:5174,http://127.0.0.1:5174

SEED_ON_STARTUP=true
RESET_DB_ON_STARTUP=false

FIREBASE_PROJECT_ID=lab-scheduling-system-tdai
VITE_API_BASE_URL=http://localhost:8001
```

### 2. Firebase Setup

1. Create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com)
2. Enable **Authentication** → **Email/Password** sign-in method
3. Go to **Project Settings** → **Service Accounts** → **Generate new private key**
4. Save the JSON file as `Backend/firebase-service-account.json`
5. Copy the Firebase web config values into `Frontend/src/app/firebase.ts`

### 3. Start PostgreSQL

**Option A — Docker (recommended):**
```powershell
docker compose up -d postgres
```

**Option B — Local PostgreSQL:**
```powershell
psql -U postgres -c "CREATE DATABASE lab_scheduling;"
```

### 4. Start Backend

```powershell
cd Backend
python -m venv venv
.\venv\Scripts\Activate.ps1          # Windows PowerShell
pip install -r requirements.txt
python -m uvicorn app.main:application --host 0.0.0.0 --port 8001 --reload
```

On first startup the backend will:
1. Create all database tables (`_ensure_schema`)
2. Reset the database if `RESET_DB_ON_STARTUP=true`
3. Seed a default **DEMO Hospital** and **Super Admin** user (`admin@demo.com` / `Admin@123`)
4. Seed sample specialists, labs, and visits if `SEED_ON_STARTUP=true`

### 5. Start Frontend

```powershell
cd Frontend
npm install
npm run dev -- --host 0.0.0.0 --port 5174
```

### 6. Login

Open `http://localhost:5174` and log in with:
- **Email:** `admin@demo.com`
- **Password:** `Admin@123`

### Local URLs
- Frontend: `http://localhost:5174`
- Backend API: `http://localhost:8001`
- API Docs (Swagger): `http://localhost:8001/docs`

---

## Core Components

### 1. Authentication (`Backend/app/auth.py` + `Frontend/src/app/firebase.ts`)

Firebase-based authentication with role-based access control.

**Flow:**
1. Frontend calls `signInWithEmailAndPassword()` via Firebase client SDK
2. Gets a Firebase ID token
3. Sends token to `POST /api/auth/login`
4. Backend verifies token via Firebase Admin SDK
5. Looks up user in local DB by `firebase_uid`
6. Returns user info with role and hospital scope

**Roles:**
- `SuperAdmin` — manages all hospitals, creates users
- `Admin` — manages a single hospital
- `Receptionist` — registers patients, creates visits
- `LabSpecialist` — manages lab queue, accepts/completes tests

**Clock Skew Handling:** The backend includes a 60-second leeway for "Token used too early" errors caused by local clock drift.

---

### 2. OR Scheduler (`app/services/or_scheduler.py`)

The mathematical optimization engine that assigns patients to labs using constraint programming.

#### Key Constraints:
1. **Lab Compatibility**: Tests can only be assigned to compatible labs
2. **Dependency Satisfaction**: Prerequisites must be completed (e.g., ECG → TMT)
3. **Time Window Fitting**: Tests must fit within specialist shifts and lab hours
4. **One Place at a Time**: Patient cannot be in multiple labs simultaneously
5. **Lab Capacity**: One test at a time per lab

#### Objective Function:
- Maximize priority scores (emergency > fasting > elderly)
- Minimize patient movement between floors
- Balance lab workload

#### Usage:
```python
from app.services.or_scheduler import ORScheduler

or_scheduler = ORScheduler(db)
or_scheduler.run_optimization()  # Runs assignment algorithm
```

---

### 3. Planning Poker (`app/services/planning_poker.py`)

Collaborative estimation system for forecasting test durations using the Planning Poker methodology.

#### Features:
- **Session Management**: Create estimation sessions for tests
- **Voting**: Team members vote using Fibonacci sequence (1, 2, 3, 5, 8, 13, 21, 34, 55, 89)
- **Consensus Calculation**: Median rounded to nearest Fibonacci number
- **Anonymous Voting**: Hidden votes until reveal

#### API Endpoints:
```
POST   /api/planning-poker/sessions           - Create new session
POST   /api/planning-poker/sessions/{id}/vote - Cast vote
POST   /api/planning-poker/sessions/{id}/reveal - Reveal votes
POST   /api/planning-poker/sessions/{id}/complete - Complete session
GET    /api/planning-poker/sessions/{id}/stats - Get statistics
```

---

### 4. Queue Service (`app/services/queue.py`)

Manages the real-time state of patient queues at each lab.

#### Key States:
- **NOT_QUEUED**: Test needs OR optimization assignment
- **WAITING**: Test assigned to lab, waiting to be called
- **CURRENT**: Patient currently being processed
- **PENDING**: Test paused (e.g., waiting for water intake)
- **DONE**: Test completed

#### Operations:
- `accept_current()`: Promote NEXT to CURRENT
- `move_current_to_pending()`: Pause current test
- `accept_from_pending()`: Resume pending test
- `complete_current()`: Mark test as done

---

### 5. Database Models (`app/models.py`)

#### Core Entities:

**Hospital**: Multi-tenant hospital record
- `name`, `code` (unique), `is_active`

**User**: System user linked to Firebase Auth
- `firebase_uid` (unique), `email`, `display_name`
- `role`: SuperAdmin, Admin, Receptionist, LabSpecialist
- `hospital_id` (FK to Hospital), `is_active`

**Visit**: Patient visit record
- `public_id`: Human-readable ID (e.g., A0114001)
- `patient_name`, `patient_age`, `patient_gender`
- `priority_type`: EMERGENCY, FASTING, ELDERLY, ROUTINE
- `arrival_time`: When patient arrived

**TestItem**: Individual test within a visit
- `test_code`: Unique test identifier (e.g., "ELECTROCARDIOGRAM_ECG")
- `test_name`: Human-readable name
- `category`: Medical category (e.g., "ECG", "Ultrasound")
- `duration_minutes`: Estimated time required
- `status`: SCHEDULED, IN_PROGRESS, COMPLETED, UNSCHEDULABLE
- `queue_status`: NOT_QUEUED, WAITING, CURRENT, PENDING, DONE
- `assigned_lab_id`: Which lab is handling this test

**Lab**: Laboratory/Room where tests are performed
- `lab_code`: Unique identifier
- `category`: Type of tests supported
- `floor`: Physical location for movement optimization
- `specialist_id`: Assigned medical professional
- `opening_time`, `closing_time`: Operating hours
- `cleanup_duration_minutes`: Time between tests

**ExplicitDependencies**: Test prerequisites
- `test_code`: The test that has a dependency
- `depends_on_test_code`: The prerequisite test
- `is_strict`: If True, must complete before; if False, recommended order

**QueueEntry**: Queue state tracking
- `lab_id`, `visit_id`, `test_item_id`: Links to entities
- `queue_type`: NEXT, CURRENT, PENDING
- `pending_since`: When test was paused

---

### 6. API Endpoints (`app/main.py`)

#### Auth:
```
POST   /api/auth/login                    - Login with Firebase token
```

#### Frontend Data (hospital-scoped, requires auth):
```
GET    /api/frontend/bootstrap             - Initial data load
GET    /api/frontend/delta                 - Incremental updates since timestamp
GET    /api/frontend/admin-dashboard       - Admin metrics
GET    /api/frontend/test-catalog          - Available tests for hospital
GET    /api/frontend/service-management    - Labs, specialists, groups
POST   /api/frontend/patients              - Create new patient visit
PATCH  /api/frontend/patients/{id}         - Update patient
```

#### Patient Management:
```
GET    /api/frontend/visits                - List all visits (paginated)
POST   /api/lims/ingest                    - Ingest from LIMS webhook
```

#### Test Operations:
```
POST   /api/tests/{id}/start              - Start test (IN_PROGRESS)
POST   /api/tests/{id}/complete           - Complete test
POST   /api/tests/{id}/unblock            - Resume from pending (NOT_QUEUED)
POST   /api/tests/{id}/pending            - Pause test
```

#### Visit Operations:
```
POST   /api/visits/{id}/block             - Block entire visit
POST   /api/visits/{id}/unblock           - Unblock entire visit
```

#### Queue/Lobby:
```
GET    /api/lobby/next                    - Get waiting patients
GET    /api/lobby/pending                 - Get pending patients
GET    /api/labs/{id}/current             - Get current patient in lab
GET    /api/lobby/feeds                   - Combined feed for displays
GET    /api/queues/{lab_id}/snapshot      - Full queue state for lab
POST   /api/queues/{lab_id}/accept-current
POST   /api/queues/{lab_id}/move-current-to-pending
POST   /api/queues/{lab_id}/accept-from-pending
POST   /api/queues/{lab_id}/complete-current
```

#### Hospital Catalog:
```
GET    /api/hospital-catalog               - Hospital's test catalog
GET    /api/hospital-catalog/global        - Global test catalog
POST   /api/hospital-catalog/bulk-import   - Import tests by code
POST   /api/hospital-catalog/import-all    - Import all catalog items
PATCH  /api/hospital-catalog/{test_code}   - Update catalog entry
DELETE /api/hospital-catalog/{test_code}   - Remove catalog entry
```

#### Super Admin:
```
POST   /api/super-admin/users             - Create new user
POST   /api/hospitals                      - Create new hospital
GET    /api/lims/config                    - Get LIMS config
POST   /api/lims/api-key                   - Generate LIMS API key
```

#### Seed/Mock:
```
POST   /api/seed/lims-patients             - Seed mock LIMS patients
POST   /api/seed/specialists               - Seed mock specialists
POST   /api/seed/labs                      - Seed mock labs
```

---

## Data Flow

### 1. New Patient Registration
1. Frontend calls `POST /api/frontend/patients` with patient details and selected tests
2. Backend creates `Visit` and `TestItem` records with `queue_status=NOT_QUEUED`
3. `ORScheduler.run_optimization()` assigns tests to optimal labs
4. Tests transition to `WAITING` state with `assigned_lab_id` set
5. WebSocket emits `visit.updated` event to all connected clients

### 2. Patient Called to Lab
1. Specialist clicks "Accept" in their dashboard
2. Frontend calls `POST /api/tests/{id}/start`
3. Test status changes to `IN_PROGRESS`, queue_status to `CURRENT`
4. WebSocket updates all dashboards

### 3. Test Completion
1. Specialist clicks "Complete"
2. Frontend calls `POST /api/tests/{id}/complete`
3. Test marked as `COMPLETED`, queue entry deleted
4. `ORScheduler.run_optimization()` recalculates for dependencies
5. If dependent tests (e.g., TMT after ECG) were blocked, they become assignable

### 4. Handling Dependencies
- TMT requires ECG to be completed first
- Ultrasound requires full bladder (Urine test should come after)
- OR solver checks `ExplicitDependencies` before assignment
- If dependency not met, test stays `NOT_QUEUED` until prerequisite completes

---

## Configuration

### Environment Variables (`.env`)

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_USER` | `postgres` | PostgreSQL username |
| `POSTGRES_PASSWORD` | `postgres` | PostgreSQL password |
| `POSTGRES_DB` | `lab_scheduling` | Database name |
| `POSTGRES_PORT` | `5433` | PostgreSQL port |
| `DATABASE_URL` | `postgresql+psycopg://...` | SQLAlchemy connection string |
| `BACKEND_PORT` | `8001` | Backend API port |
| `FRONTEND_PORT` | `5174` | Frontend dev server port |
| `BACKEND_CORS_ORIGINS` | `http://localhost:5174,...` | Allowed CORS origins |
| `SEED_ON_STARTUP` | `true` | Seed sample data on startup |
| `RESET_DB_ON_STARTUP` | `false` | Reset (truncate) all data on startup |
| `FIREBASE_PROJECT_ID` | — | Firebase project ID |
| `VITE_API_BASE_URL` | `http://localhost:8001` | Backend URL for frontend |

---

## Docker Setup

### Start all services
```powershell
docker compose up -d --build
```

### Start only PostgreSQL
```powershell
docker compose up -d postgres
```

### View logs
```powershell
docker compose logs -f backend
docker compose logs -f frontend
```

### Stop and remove data
```powershell
docker compose down -v   # removes volumes (resets DB)
docker compose down      # keeps volumes
```

See [DOCKER_SETUP.md](DOCKER_SETUP.md) for detailed Docker instructions.

---

## OR Solver Algorithm Details

### Decision Variables
```python
x[(test_id, lab_id)] = 1 if test assigned to lab, 0 otherwise
```

### Constraints (Mathematical)
1. **Assignment**: `sum(x[(test_id, lab_id)] for all labs) == 1` (each test to exactly one lab)
2. **Compatibility**: `x[(test_id, lab_id)] == 0` if lab cannot perform test
3. **Dependencies**: `x[(test_id, lab_id)] == 0` if prerequisite not completed
4. **Time Window**: `x[(test_id, lab_id)] == 0` if test doesn't fit in shift hours
5. **One Place**: `x[(test_id, lab_id)] == 0` if patient already has active test
6. **Capacity**: `sum(x[(test_id, lab_id)] for all tests) <= 1` per lab

### Objective Function
```
Maximize: sum(priority_score * x[(test, lab)] - movement_penalty * x[(test, lab)])
```

---

## Testing

### Sample API Calls
```bash
# Create a patient
curl -X POST http://localhost:8001/api/frontend/patients \
  -H "Content-Type: application/json" \
  -d '{
    "patient_name": "John Doe",
    "patient_age": 45,
    "patient_gender": "Male",
    "priority_type": "ROUTINE",
    "test_names": ["Complete Blood Count", "ECG"]
  }'

# Get lobby status
curl http://localhost:8001/api/lobby/next

# Start a test
curl -X POST http://localhost:8001/api/tests/1/start
```

---

## Troubleshooting

### Common Issues

**Backend won't start (NameError: Visit not defined)**
- Fix: Ensure `from app.models import ...` is outside TYPE_CHECKING block in or_scheduler.py

**Patients stuck in NOT_QUEUED**
- Check that `ORScheduler.get_pending_tests()` queries for NOT_QUEUED status
- Verify OR-Tools constraints aren't too restrictive

**Database connection errors**
- Verify postgres container is healthy: `docker ps`
- Check DATABASE_URL environment variable matches your PostgreSQL port (5433 by default)
- If using Docker: `docker compose up -d postgres`

**401 Unauthorized on login**
- Ensure `Backend/firebase-service-account.json` exists and is valid
- Verify `FIREBASE_PROJECT_ID` in `.env` matches your Firebase project
- Check that the Firebase user exists in both Firebase Auth and the local `users` table
- The backend auto-seeds a Super Admin on startup if none exists (`admin@demo.com` / `Admin@123`)

**"Token used too early" / Clock skew errors**
- Your system clock is behind Firebase servers. Sync with: `w32tm /resync` (run as admin)
- The backend includes a 60-second clock-skew leeway as a fallback

**CORS errors in browser console**
- Ensure `BACKEND_CORS_ORIGINS` in `.env` includes your frontend origin
- The CORS middleware wraps the outer ASGI app (Socket.IO + FastAPI)

**Frontend can't connect to backend**
- Verify `VITE_API_BASE_URL=http://localhost:8001` in `.env`
- The Vite dev server proxies `/api` requests to the backend automatically

**Tests not auto-assigning**
- Ensure `run_optimization()` is called after patient creation
- Check that tests are created with `queue_status=NOT_QUEUED`

---

## Contributing

### Code Structure
```
lab-schedulling-tdai/
├── .env                          # Root environment config (all services)
├── .env.example                  # Template for .env
├── docker-compose.yml            # Docker Compose orchestration
│
├── Backend/
│   ├── app/
│   │   ├── main.py               # FastAPI app, all API endpoints, startup events
│   │   ├── models.py             # SQLAlchemy ORM models (all tables)
│   │   ├── db.py                 # Engine, SessionLocal, get_db dependency
│   │   ├── config.py             # Settings loaded from .env
│   │   ├── auth.py               # Firebase Admin auth, token verification, RBAC
│   │   ├── schemas.py            # Pydantic request/response schemas
│   │   ├── realtime.py           # Socket.IO server setup and mount
│   │   ├── catalog.py            # Test catalog mapping
│   │   ├── seed.py               # reset_database() and seed_database()
│   │   ├── seed_data.py          # Extended seed data (specialists, labs, visits)
│   │   ├── seed_data/            # JSON files for test catalog seeding
│   │   └── services/
│   │       ├── bootstrap.py      # Bootstrap/delta payloads for frontend
│   │       ├── or_scheduler.py   # OR-Tools CP-SAT optimization engine
│   │       ├── planning_poker.py # Planning Poker estimation sessions
│   │       ├── queue.py          # Queue state management service
│   │       ├── scheduling.py     # Legacy scheduling wrapper
│   │       ├── patient_ids.py    # Patient public ID generation
│   │       └── lims_webhook.py   # LIMS webhook ingestion handler
│   ├── firebase-service-account.json  # Firebase service account key
│   ├── requirements.txt          # Python dependencies
│   ├── Dockerfile                # Backend container definition
│   └── entrypoint.sh             # Docker entrypoint (wait for postgres)
│
├── Frontend/
│   ├── src/
│   │   ├── main.tsx              # React entry point
│   │   ├── app/
│   │   │   ├── App.tsx           # Root component with auth + realtime
│   │   │   ├── firebase.ts       # Firebase client SDK config
│   │   │   ├── routes.tsx        # React Router config
│   │   │   ├── types.ts          # TypeScript type definitions
│   │   │   ├── api/
│   │   │   │   ├── client.ts     # Axios instance with auth interceptor
│   │   │   │   ├── frontend.ts   # Frontend API client methods
│   │   │   │   └── resolveApiUrl.ts  # API base URL resolution
│   │   │   ├── store/
│   │   │   │   ├── useAuthStore.ts   # Auth state (login, logout, token)
│   │   │   │   └── useAppStore.ts    # App data state (visits, labs, etc.)
│   │   │   ├── hooks/
│   │   │   │   └── useRealTimeUpdates.ts  # Socket.IO + delta sync
│   │   │   ├── pages/
│   │   │   │   ├── RoleSelection.tsx         # Role-based dashboard picker
│   │   │   │   ├── ReceptionistDashboard.tsx # Patient registration view
│   │   │   │   ├── LabSpecialistDashboard.tsx # Lab queue management
│   │   │   │   ├── AdminDashboard.tsx        # Hospital admin view
│   │   │   │   ├── SuperAdminDashboard.tsx   # Super admin (multi-hospital)
│   │   │   │   ├── QueueDisplay.tsx          # Public queue display
│   │   │   │   ├── LabSpecificQueueDisplay.tsx  # Single lab queue
│   │   │   │   └── GroupQueueDisplay.tsx     # Lab group queue
│   │   │   └── components/
│   │   │       ├── ProtectedRoute.tsx       # Auth guard component
│   │   │       ├── dashboard/               # Dashboard UI components
│   │   │       └── ui/                      # shadcn/ui primitives
│   │   └── styles/              # Global CSS / Tailwind
│   ├── vite.config.ts           # Vite config with proxy + env loading
│   ├── package.json             # Node dependencies
│   └── Dockerfile               # Frontend container definition
│
└── LSS Data schema.xlsx         # Original data schema reference
```

---

## License

MIT License - See LICENSE file for details

---

## Contact

For support or questions, please contact the development team.

---

*Last Updated: May 5, 2026*
*Version: 3.0 (Firebase Auth + Multi-Hospital)*
