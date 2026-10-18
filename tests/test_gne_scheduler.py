import json
import shutil
import subprocess
from pathlib import Path

from core.scheduler import gne_scheduler


def write_config(path: Path, **overrides) -> Path:
    config = {"enabled": True, "interval_minutes": 1440, "run_on_startup": False}
    config.update(overrides)
    path.write_text(json.dumps(config), encoding="utf-8")
    return path


def test_config_load(tmp_path: Path) -> None:
    path = write_config(tmp_path / "schedule_config.json")
    assert gne_scheduler.load_config(path) == {
        "enabled": True,
        "interval_minutes": 1440,
        "run_on_startup": False,
    }


def test_interval_respect(tmp_path: Path, monkeypatch) -> None:
    path = write_config(tmp_path / "schedule_config.json", interval_minutes=2, run_on_startup=True)
    sleeps = []
    invocations = []
    monkeypatch.setattr(gne_scheduler, "run_once", lambda logger=print: invocations.append("run"))

    completed = gne_scheduler.run_scheduler(
        path,
        sleep_fn=sleeps.append,
        max_runs=2,
        logger=lambda _: None,
    )

    assert completed == 2
    assert invocations == ["run", "run"]
    assert sleeps == [120.0]


def test_pipeline_invocation(monkeypatch) -> None:
    for _, state_name, _ in gne_scheduler.STATE_LAYERS:
        monkeypatch.setattr(gne_scheduler.gne_state, state_name, [])
    signal = {"source": "VA News", "title": "Funding signal", "published_date": "2026-09-14"}
    snapshot = {snapshot_name: [signal] for snapshot_name, _, _ in gne_scheduler.STATE_LAYERS}
    calls = []
    monkeypatch.setattr(gne_scheduler, "run_full_pipeline", lambda: calls.append("pipeline") or snapshot)

    result = gne_scheduler.run_once(logger=lambda _: None)

    assert calls == ["pipeline"]
    assert result["signals_added"] == 1
    assert result["semantics_added"] == 1
    assert result["classifications_added"] == 1
    assert result["forecasts_added"] == 1
    assert result["modernization_added"] == 1
    assert result["partners_added"] == 1


def test_scheduler_bootstrap(tmp_path: Path) -> None:
    node = shutil.which("node") or ("/opt/homebrew/bin/node" if Path("/opt/homebrew/bin/node").exists() else None)
    if not node:
        raise AssertionError("Node.js is required for the server bootstrap test")
    config_dir = tmp_path / "core" / "scheduler"
    config_dir.mkdir(parents=True)
    write_config(config_dir / "schedule_config.json")
    module_path = Path(__file__).resolve().parents[1] / "server" / "index.js"
    script = f"""
      const {{ EventEmitter }} = require('events');
      const {{ startGneScheduler }} = require({json.dumps(str(module_path))});
      let calls = 0;
      let killed = false;
      function fakeSpawn(command, args, options) {{
        calls += 1;
        const child = new EventEmitter();
        child.pid = 42;
        child.killed = false;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {{ child.killed = true; killed = true; }};
        child.command = command;
        child.args = args;
        child.options = options;
        return child;
      }}
      const scheduler = startGneScheduler({{
        rootDir: {json.dumps(str(tmp_path))},
        pythonBin: '/usr/bin/python3',
        spawnProcess: fakeSpawn,
                restartDelayMs: 0,
        logger: {{ info() {{}}, error() {{}} }},
      }});
      const child = scheduler.child;
            child.emit('exit', 1, null);
            setTimeout(() => {{
                scheduler.stop();
                console.log(JSON.stringify({{
                    enabled: scheduler.enabled,
                    calls,
                    killed,
                    command: child.command,
                    script: child.args[0],
                    cwd: child.options.cwd,
                }}));
            }}, 10);
    """
    result = subprocess.run([node, "-e", script], cwd=Path(__file__).resolve().parents[1], check=True, capture_output=True, text=True)
    payload = json.loads(result.stdout)
    assert payload["enabled"] is True
    assert payload["calls"] == 2
    assert payload["killed"] is True
    assert payload["command"] == "/usr/bin/python3"
    assert payload["script"].endswith("core/scheduler/gne_scheduler.py")
    assert payload["cwd"] == str(tmp_path)

    server_source = (Path(__file__).resolve().parents[1] / "server.js").read_text(encoding="utf-8")
    assert "startGneScheduler" in server_source
