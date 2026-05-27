from pathlib import Path


ROOTS = [Path("/opt/hermes"), Path("/usr/local/lib"), Path("/opt/data")]
TARGET = "openai/lib/_parsing/_responses.py"
OLD = "for output in response.output:"
NEW = "for output in (response.output or []):"


def main() -> None:
    patched = []
    for root in ROOTS:
        if not root.exists():
            continue
        for path in root.rglob("_responses.py"):
            normalized = str(path).replace("\\", "/")
            if TARGET not in normalized:
                continue
            text = path.read_text()
            if NEW in text:
                patched.append(f"{path} already patched")
                continue
            if OLD not in text:
                patched.append(f"{path} skipped: expected parser loop not found")
                continue
            path.write_text(text.replace(OLD, NEW, 1))
            patched.append(f"{path} patched")

    if not patched:
        raise SystemExit("OpenAI Responses parser not found; Codex hotfix was not applied")
    print("Codex None-output hotfix:")
    for line in patched:
        print(f"- {line}")


if __name__ == "__main__":
    main()
