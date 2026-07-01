import os

os.system("go mod download")
os.system("go build -o agentd ./cmd/agentd/main.go")
os.system("strip agentd")
