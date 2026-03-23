backend:
    cd backend && ../.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000

frontend:
    cd frontend && npm run dev -- --host 0.0.0.0
