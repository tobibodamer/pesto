//! Coding agents he keeps an eye on: Claude Code runs he starts himself, and
//! the person's own sessions, which tell him through HTTP hooks when they
//! stop, ask for something or end.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Marks the hooks he puts into Claude Code's settings, so he can find and take out his own.
const HOOK_PATH: &str = "/pesto/hook";
const HOOK_EVENTS: &[&str] = &["UserPromptSubmit", "Stop", "Notification", "SessionEnd"];
/// What of an agent's last message is passed on; the mind only ever needs the gist.
const SAID_MOST: usize = 4000;

#[derive(Default)]
pub struct Agents {
    /// Process ids of the runs still going, by job id.
    runs: Mutex<HashMap<String, u32>>,
    listening: Mutex<Option<u16>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunArgs {
    job: String,
    cwd: String,
    prompt: String,
    /// A session to continue instead of starting a new one.
    resume: Option<String>,
    /// Continue the session under a new id, leaving the original as it was.
    fork: bool,
    permission_mode: String,
    /// Permission rules such as `Bash(pnpm test)` allowed for this run only.
    allow: Vec<String>,
    command: String,
    model: String,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum RunEvent {
    /// The run has its session id.
    Session { job: String, session: String },
    /// What it is doing now, in a few words.
    Step { job: String, text: String },
    Done {
        job: String,
        session: String,
        result: String,
        failed: bool,
        denials: Vec<Denial>,
        cost: f64,
    },
    /// The process ended without a result.
    Ended { job: String, why: String },
}

#[derive(Serialize, Clone)]
struct Denial {
    /// What it was not allowed to do, in a few words.
    what: String,
    /// The rule that would allow it next time.
    rule: String,
}

fn clip(s: &str, most: usize) -> String {
    if s.chars().count() <= most {
        return s.to_string();
    }
    let mut out: String = s.chars().take(most).collect();
    out.push('…');
    out
}

fn denial(d: &Value) -> Denial {
    let tool = d["tool_name"].as_str().unwrap_or("a tool").to_string();
    let input = &d["tool_input"];
    let field = |k: &str| input[k].as_str().map(|s| clip(s, 200));
    match (tool.as_str(), field("command"), field("file_path"), field("url")) {
        ("Bash" | "PowerShell", Some(cmd), _, _) => Denial {
            what: format!("run `{cmd}`"),
            rule: format!("{tool}({cmd})"),
        },
        (_, _, Some(path), _) => Denial {
            what: format!("{tool} {path}"),
            rule: tool,
        },
        (_, _, _, Some(url)) => Denial {
            what: format!("{tool} {url}"),
            rule: tool,
        },
        _ => Denial {
            what: tool.clone(),
            rule: tool,
        },
    }
}

/// One line of `--output-format stream-json`, as something worth telling the frontend, if it is.
fn event(job: &str, line: &Value) -> Option<RunEvent> {
    let job = job.to_string();
    match (line["type"].as_str()?, line["subtype"].as_str()) {
        ("system", Some("init")) => Some(RunEvent::Session {
            job,
            session: line["session_id"].as_str()?.to_string(),
        }),
        ("system", Some("task_summary")) => Some(RunEvent::Step {
            job,
            text: clip(line["detail"].as_str()?, 160),
        }),
        ("result", _) => Some(RunEvent::Done {
            job,
            session: line["session_id"].as_str().unwrap_or("").to_string(),
            result: clip(line["result"].as_str().unwrap_or(""), SAID_MOST),
            failed: line["is_error"].as_bool().unwrap_or(false),
            denials: line["permission_denials"]
                .as_array()
                .map(|all| all.iter().map(denial).collect())
                .unwrap_or_default(),
            cost: line["total_cost_usd"].as_f64().unwrap_or(0.0),
        }),
        _ => None,
    }
}

/// Starts `claude -p` in `cwd`, or continues a session there, and reports on it as `agent://run` events.
#[tauri::command]
pub fn agent_run(app: AppHandle, agents: State<'_, Agents>, args: RunArgs) -> Result<(), String> {
    if !Path::new(&args.cwd).is_dir() {
        return Err(format!("there is no folder {}", args.cwd));
    }
    let mut cmd = Command::new(&args.command);
    cmd.current_dir(&args.cwd)
        .args(["-p", "--output-format", "stream-json", "--verbose"])
        .args(["--permission-mode", &args.permission_mode]);
    if let Some(session) = &args.resume {
        cmd.args(["--resume", session]);
        if args.fork {
            cmd.arg("--fork-session");
        }
    }
    for rule in &args.allow {
        cmd.args(["--allowedTools", rule]);
    }
    if !args.model.is_empty() {
        cmd.args(["--model", &args.model]);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("Claude Code is not installed: there is no `{}` to run", args.command),
        _ => format!("Claude Code would not start: {e}"),
    })?;
    // The prompt goes in on stdin, so nothing in it is read as a flag.
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(args.prompt.as_bytes());
    }
    agents.runs.lock().unwrap_or_else(|e| e.into_inner()).insert(args.job.clone(), child.id());

    let stderr = child.stderr.take();
    let tail = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut err) = stderr {
            let _ = err.read_to_string(&mut text);
        }
        text
    });
    let stdout = child.stdout.take();
    let job = args.job;
    std::thread::spawn(move || {
        let mut finished = false;
        if let Some(out) = stdout {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(e) = event(&job, &value) {
                    finished |= matches!(e, RunEvent::Done { .. });
                    let _ = app.emit("agent://run", e);
                }
            }
        }
        let status = child.wait();
        let err = tail.join().unwrap_or_default();
        use tauri::Manager;
        let agents = app.state::<Agents>();
        let stopped = agents.runs.lock().unwrap_or_else(|e| e.into_inner()).remove(&job).is_none();
        if !finished {
            let why = if stopped {
                "stopped".to_string()
            } else {
                let last = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
                match status {
                    Ok(s) => clip(&format!("exited with {s}. {last}"), 300),
                    Err(e) => e.to_string(),
                }
            };
            let _ = app.emit("agent://run", RunEvent::Ended { job, why });
        }
    });
    Ok(())
}

/// Ends a run and whatever it started.
#[tauri::command]
pub fn agent_stop(agents: State<'_, Agents>, job: String) -> Result<(), String> {
    let pid = agents.runs.lock().unwrap_or_else(|e| e.into_inner()).remove(&job);
    let Some(pid) = pid else { return Ok(()) };
    let mut kill = Command::new("taskkill");
    kill.args(["/PID", &pid.to_string(), "/T", "/F"]);
    #[cfg(windows)]
    kill.creation_flags(CREATE_NO_WINDOW);
    kill.output().map_err(|e| e.to_string())?;
    Ok(())
}

/// The fields of a hook's payload he uses. The rest stays out of the overlay.
fn hook_event(body: &Value) -> Value {
    let text = |k: &str, most: usize| body[k].as_str().map(|s| clip(s, most));
    json!({
        "event": body["hook_event_name"],
        "session": body["session_id"],
        "cwd": body["cwd"],
        "subagent": body.get("agent_id").is_some(),
        "permissionMode": body["permission_mode"],
        "title": text("session_title", 120),
        "said": text("last_assistant_message", SAID_MOST),
        "message": text("message", 400),
        "type": body["notification_type"],
        "prompt": text("prompt", 300),
        "reason": body["reason"],
    })
}

fn serve(app: &AppHandle, mut stream: TcpStream, token: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });
    let mut request = String::new();
    if reader.read_line(&mut request).is_err() {
        return;
    }
    let mut length = 0usize;
    let mut authorised = false;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            let value = value.trim();
            if name.eq_ignore_ascii_case("content-length") {
                length = value.parse().unwrap_or(0);
            } else if name.eq_ignore_ascii_case("x-pesto-token") {
                authorised = !token.is_empty() && value == token;
            }
        }
    }
    let mut body = vec![0u8; length.min(1 << 20)];
    let ok = reader.read_exact(&mut body).is_ok();
    let status = if !authorised {
        "403 Forbidden"
    } else if !request.starts_with("POST ") || !request.contains(HOOK_PATH) || !ok {
        "400 Bad Request"
    } else {
        "200 OK"
    };
    let _ = stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes());
    if status.starts_with("200") {
        if let Ok(value) = serde_json::from_slice::<Value>(&body) {
            let _ = app.emit("agent://hook", hook_event(&value));
        }
    }
}

/// Listens on localhost for Claude Code's hooks. Only requests carrying `token` are heard.
#[tauri::command]
pub fn agent_listen(app: AppHandle, agents: State<'_, Agents>, port: u16, token: String) -> Result<(), String> {
    let mut listening = agents.listening.lock().unwrap_or_else(|e| e.into_inner());
    if *listening == Some(port) {
        return Ok(());
    }
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| format!("port {port}: {e}"))?;
    *listening = Some(port);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            serve(&app, stream, &token);
        }
    });
    Ok(())
}

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(home().ok_or("no home folder")?.join(".claude").join("settings.json"))
}

fn is_ours(group: &Value) -> bool {
    group["hooks"]
        .as_array()
        .is_some_and(|hooks| hooks.iter().any(|h| h["url"].as_str().is_some_and(|u| u.contains(HOOK_PATH))))
}

/// Puts his hooks into Claude Code's user settings, or takes them out, leaving everything else as it was.
#[tauri::command]
pub fn agent_hooks(on: bool, port: u16, token: String) -> Result<(), String> {
    let path = settings_path()?;
    let mut settings: Value = match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("{}: {e}", path.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(e.to_string()),
    };
    let root = settings.as_object_mut().ok_or("Claude Code's settings are not an object")?;
    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks.as_object_mut().ok_or("the hooks in Claude Code's settings are not an object")?;
    for name in HOOK_EVENTS {
        let groups = hooks.entry(*name).or_insert_with(|| json!([]));
        let Some(list) = groups.as_array_mut() else { continue };
        list.retain(|g| !is_ours(g));
        if on {
            list.push(json!({ "hooks": [{
                "type": "http",
                "url": format!("http://127.0.0.1:{port}{HOOK_PATH}"),
                "timeout": 5,
                "headers": { "x-pesto-token": token },
            }]}));
        }
    }
    hooks.retain(|_, v| v.as_array().is_none_or(|a| !a.is_empty()));
    if hooks.is_empty() {
        root.remove("hooks");
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, text + "\n").map_err(|e| e.to_string())
}

/// Whether his hooks are in Claude Code's user settings.
#[tauri::command]
pub fn agent_hooks_on() -> bool {
    let Ok(path) = settings_path() else { return false };
    let Ok(text) = fs::read_to_string(path) else { return false };
    let Ok(settings) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) else { return false };
    HOOK_EVENTS.iter().all(|name| settings["hooks"][name].as_array().is_some_and(|g| g.iter().any(is_ours)))
}

#[derive(Serialize)]
pub struct Project {
    name: String,
    path: String,
}

fn named(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    // A worktree is known by the repository it belongs to.
    if let Some((repo, tree)) = s.split_once("/.claude/worktrees/") {
        let repo = repo.rsplit('/').next().unwrap_or(repo);
        return format!("{repo} ({tree})");
    }
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(s)
}

/// The folder a transcript was recorded in, from the first of its lines that says.
fn transcript_cwd(dir: &Path) -> Option<(SystemTime, PathBuf)> {
    let newest = fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .max_by_key(|(t, _)| *t)?;
    let file = fs::File::open(&newest.1).ok()?;
    BufReader::new(file)
        .lines()
        .take(40)
        .map_while(Result::ok)
        .find_map(|l| serde_json::from_str::<Value>(&l).ok()?["cwd"].as_str().map(PathBuf::from))
        .map(|cwd| (newest.0, cwd))
}

/// The folders Claude Code has been used in on this computer, most recently used first.
/// Worktrees and scratch folders are left out.
#[tauri::command]
pub async fn agent_projects() -> Vec<Project> {
    tauri::async_runtime::spawn_blocking(projects).await.unwrap_or_default()
}

fn projects() -> Vec<Project> {
    let Some(home) = home() else { return vec![] };
    let Ok(dirs) = fs::read_dir(home.join(".claude").join("projects")) else { return vec![] };
    let mut dirs: Vec<(SystemTime, PathBuf)> = dirs
        .flatten()
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    dirs.sort_by(|a, b| b.0.cmp(&a.0));
    let mut seen = std::collections::HashSet::new();
    dirs.iter()
        .take(400)
        .filter_map(|(_, dir)| transcript_cwd(dir))
        .filter(|(_, cwd)| {
            let s = cwd.to_string_lossy();
            cwd.is_dir() && *cwd != home && !s.contains("AppData") && !s.contains("scratch") && !s.replace('\\', "/").contains("/.claude/worktrees/")
        })
        .filter(|(_, cwd)| seen.insert(cwd.to_string_lossy().to_lowercase()))
        .take(30)
        .map(|(_, cwd)| Project { name: named(&cwd), path: cwd.to_string_lossy().into_owned() })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_projects_and_worktrees() {
        assert_eq!(named(Path::new(r"X:\repos\pesto")), "pesto");
        assert_eq!(named(Path::new(r"X:\repos\pesto\.claude\worktrees\brave-fox")), "pesto (brave-fox)");
    }

    #[test]
    fn rules_for_denials() {
        let d = denial(&json!({ "tool_name": "Bash", "tool_input": { "command": "pnpm test" } }));
        assert_eq!(d.rule, "Bash(pnpm test)");
        let d = denial(&json!({ "tool_name": "Write", "tool_input": { "file_path": "a.txt", "content": "x" } }));
        assert_eq!(d.rule, "Write");
        assert_eq!(d.what, "Write a.txt");
    }

    #[test]
    #[ignore]
    fn lists_projects() {
        for p in projects() {
            println!("{} -> {}", p.name, p.path);
        }
    }
}
