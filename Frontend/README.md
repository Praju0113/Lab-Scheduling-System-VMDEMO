# Frontend

React + Vite frontend for the lab scheduling system.

## Stack
- React
- Vite
- Tailwind CSS
- Axios
- Socket.IO client
- Zustand

## Requirements
- Node.js 20+
- npm

## Environment
The frontend reads Vite environment variables from the repository root `.env`.

Example:

```env
FRONTEND_PORT=5174
VITE_API_BASE_URL=http://localhost:8001
```

The app also supports `VITE_API_URL`, but one of those variables must exist in the repository root `.env`.

## Install
```powershell
cd Frontend
npm install
```

## Run Locally
```powershell
cd Frontend
npm run dev -- --host 0.0.0.0 --port 5174
```

Default dev URL when `FRONTEND_PORT=5174`:

```text
http://localhost:5174
```

## Build
```powershell
cd Frontend
npm run build
```

## Docker (Optional)
From the repository root:

```powershell
docker compose up --build frontend
```

## Notes
- API requests are routed through the configured Vite proxy in development.
- Realtime updates use Socket.IO and expect the backend to serve the mounted ASGI application at `/socket.io`.
