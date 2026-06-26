import os

os.environ["DATABASE_URL"] = "sqlite:///./test.db"
os.environ["REDIS_URL"] = "memory://"
os.environ["MOCK_PROVIDERS"] = "true"
os.environ["ASR_PROVIDER"] = "mock"
