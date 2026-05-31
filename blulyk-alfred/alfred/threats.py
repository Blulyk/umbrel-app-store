import re
from collections import Counter
from pathlib import Path


FAILED_PATTERNS = [
    re.compile(r"Failed password .* from (?P<ip>[0-9a-fA-F:.]+)"),
    re.compile(r"Invalid user .* from (?P<ip>[0-9a-fA-F:.]+)"),
    re.compile(r"authentication failure.*rhost=(?P<ip>[0-9a-fA-F:.]+)"),
]


def scan_auth_log(path: str, max_lines: int = 3000) -> dict[str, object]:
    log_path = Path(path)
    if not log_path.exists():
        return {"status": "Unavailable", "anomalies": [], "summary": f"{path} not mounted."}

    try:
        lines = log_path.read_text(encoding="utf-8", errors="ignore").splitlines()[-max_lines:]
    except OSError as exc:
        return {"status": "Unavailable", "anomalies": [], "summary": str(exc)}

    hits: Counter[str] = Counter()
    for line in lines:
        for pattern in FAILED_PATTERNS:
            match = pattern.search(line)
            if match:
                hits[match.group("ip")] += 1

    anomalies = [
        {
            "ip": ip,
            "failed_attempts": count,
            "assessment": f"Intrusion Anomalies Detected at Perimeter {ip}",
        }
        for ip, count in hits.most_common()
        if count >= 3
    ]
    status = "Anomalous" if anomalies else "Clear"
    return {"status": status, "anomalies": anomalies, "summary": f"Scanned {len(lines)} auth lines."}
