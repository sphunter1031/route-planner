FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=8080

WORKDIR /app

COPY requirements.txt /app/requirements.txt

# ✅ pip를 python -m pip로 강제 + 로그 보이게
RUN python -m pip install --upgrade pip \
 && python -m pip install --no-cache-dir -r /app/requirements.txt

COPY . /app

CMD ["python", "-m", "uvicorn", "solver_app:app", "--host", "0.0.0.0", "--port", "8080"]
