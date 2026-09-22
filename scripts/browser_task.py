#!/usr/bin/env python3
"""Run a Browser Use task with LM Studio as the LLM backend."""
import asyncio
import json
import os
import sys


async def main() -> None:
    if len(sys.argv) < 4:
        print(json.dumps({"error": "usage: browser_task.py <task> <model> <api_base>"}))
        sys.exit(1)

    task = sys.argv[1]
    model = sys.argv[2]
    api_base = sys.argv[3].rstrip("/")
    if not api_base.endswith("/v1"):
        api_base = api_base + "/v1"

    api_key = os.environ.get("LM_STUDIO_API_TOKEN") or os.environ.get("OPENAI_API_KEY") or "lm-studio"

    try:
        from browser_use import Agent, ChatOpenAI
    except ImportError as e:
        print(json.dumps({"error": f"browser-use not installed: {e}"}))
        sys.exit(1)

    llm = ChatOpenAI(model=model, base_url=api_base, api_key=api_key)
    agent = Agent(task=task, llm=llm)
    result = await agent.run()
    print(str(result))


if __name__ == "__main__":
    asyncio.run(main())
