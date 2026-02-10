import os
import requests
from dotenv import load_dotenv

load_dotenv()
key = os.getenv("GOOGLE_API_KEY")

url = f"https://generativelanguage.googleapis.com/v1beta/models?key={key}"
response = requests.get(url)
data = response.json()

if "models" in data:
    for m in data["models"]:
        if "bidiGenerateContent" in m.get("supportedGenerationMethods", []):
            print(f"Model: {m['name']}")
else:
    print(data)
