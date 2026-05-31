import os
from dataclasses import asdict, dataclass

import psutil

from alfred.config import Settings


@dataclass
class VitalReport:
    cpu_percent: float
    ram_percent: float
    disk_percent: float
    cpu_temperature_c: float | None
    status: str
    notes: list[str]


def read_vitals(settings: Settings) -> VitalReport:
    cpu_percent = psutil.cpu_percent(interval=0.05)
    ram_percent = psutil.virtual_memory().percent
    disk_percent = psutil.disk_usage("/").percent
    cpu_temperature = _cpu_temperature()

    notes: list[str] = []
    status = "Nominal"

    if cpu_temperature and cpu_temperature >= settings.cpu_temp_critical:
        status = "System Trauma"
        notes.append(f"CPU temperature critical at {cpu_temperature:.1f}C.")
    elif cpu_temperature and cpu_temperature >= settings.cpu_temp_caution:
        status = "Elevated Stress Levels"
        notes.append(f"CPU temperature elevated at {cpu_temperature:.1f}C.")

    if ram_percent >= settings.ram_pressure_caution:
        status = "Elevated Stress Levels" if status == "Nominal" else status
        notes.append(f"RAM pressure at {ram_percent:.1f}%.")

    if disk_percent >= settings.disk_pressure_caution:
        status = "Elevated Stress Levels" if status == "Nominal" else status
        notes.append(f"Storage pressure at {disk_percent:.1f}%.")

    if not notes:
        notes.append("Vitals stable. No theatrics required.")

    return VitalReport(cpu_percent, ram_percent, disk_percent, cpu_temperature, status, notes)


def _cpu_temperature() -> float | None:
    try:
        readings = psutil.sensors_temperatures(fahrenheit=False)
    except (AttributeError, OSError):
        return None
    candidates: list[float] = []
    for entries in readings.values():
        candidates.extend(entry.current for entry in entries if entry.current is not None)
    if candidates:
        return max(candidates)

    thermal_root = "/sys/class/thermal"
    if os.path.isdir(thermal_root):
        for name in os.listdir(thermal_root):
            path = os.path.join(thermal_root, name, "temp")
            try:
                with open(path, "r", encoding="utf-8") as handle:
                    raw = float(handle.read().strip())
                return raw / 1000 if raw > 1000 else raw
            except (OSError, ValueError):
                continue
    return None


def vitals_payload(settings: Settings) -> dict[str, object]:
    return asdict(read_vitals(settings))
