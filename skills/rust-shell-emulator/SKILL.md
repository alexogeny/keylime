---
name: rust-shell-emulator
description: >
  Shell emulator / terminal emulator auditing and enhancement skill for Rust projects. Use when reviewing, debugging, or extending a Rust shell or terminal emulator — covering PTY/TTY architecture, POSIX shell lexing and parsing, AST design, word expansion, process management, job control, signal handling, and VT100/ANSI terminal emulation. Grounded in 2024–2025 research and real Rust shell implementations (brush, fish, nsh, Alacritty, WezTerm).
---

# Rust Shell Emulator Skill

Use this skill when working on a shell or terminal emulator written in Rust. It covers the full stack from TTY primitives to shell grammar. When handed a codebase, follow the audit workflow in §1, then use the reference sections to guide improvements.

---

## Architecture Overview

A shell emulator has two largely orthogonal subsystems that must cooperate:

```
┌─────────────────────────────────────────────────────────────┐
│                    Shell Emulator                           │
│                                                             │
│  ┌──────────────┐    ┌───────────────────────────────────┐  │
│  │  Terminal    │    │         Shell Engine              │  │
│  │  Layer       │    │                                   │  │
│  │              │    │  Lexer → Parser → Expander        │  │
│  │  PTY master  │◄──►│  → Executor → Job Control        │  │
│  │  VT parser   │    │                                   │  │
│  │  crossterm   │    │  Builtins, Variables, History     │  │
│  └──────────────┘    └───────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

The terminal layer handles raw bytes ↔ visual cells. The shell engine handles text ↔ processes. A *shell emulator* (as opposed to a terminal emulator) may skip the VT rendering layer and focus on the shell engine + PTY integration.

---

## §1 — Audit Workflow

When handed a shell emulator codebase, work through these layers in order:

### Layer 1: Project Structure
```bash
cargo tree                    # Dependency graph — look for: nix, crossterm, tokio, nom/pest/logos
cargo clippy -- -D warnings   # Surface obvious issues
cargo test                    # Run test suite; note coverage gaps
grep -r "unwrap()\|expect(" src/  # Unwrap audit — each is a potential panic
grep -r "unsafe" src/         # Unsafe audit — each block needs a SAFETY comment
```

Questions to answer:
- [ ] What crates handle PTY, terminal I/O, lexing, parsing?
- [ ] Is there a clear separation between lexer / parser / expander / executor?
- [ ] Are errors propagated via `Result` or via panics?
- [ ] Is there a test for each POSIX shell construct?

### Layer 2: Lexer Audit

The lexer (tokeniser) is the foundation. It must handle:

**POSIX token types:**
```
Word          — unquoted string, parameter ref, command subst
AssignmentWord — NAME=value at start of simple command
Name          — [a-zA-Z_][a-zA-Z0-9_]* (for function names, for-loop vars)
Newline       — line terminator (may end a command)
IO_NUMBER     — digit+ before < or >
```

**Operators (must be recognised as single tokens):**
```
&&  ||  ;;  <<  >>  <&  >&  <>  <<-  >|
|   &   ;   <   >   (   )   {   }
```

**Reserved words (only reserved at start of command):**
```
if then else elif fi
while until do done
for case esac
{ } [[ ]] (( ))   ← bash extensions
! in
```

**Audit checklist for the lexer:**
- [ ] Single quotes: content taken literally, no expansion, no backslash escaping — `'it'\''s'` is tricky
- [ ] Double quotes: parameter expansion `$VAR`, command substitution `$()`, arithmetic `$(())`, and `\"` `\\` `\$` `\`` escapes active; everything else is literal including newlines
- [ ] Backslash outside quotes: escapes next char (including newline continuation)
- [ ] Parameter expansion forms: `$VAR`, `${VAR}`, `${VAR:-default}`, `${VAR:+alt}`, `${VAR:?err}`, `${VAR:=assign}`, `${#VAR}`, `${VAR%pattern}`, `${VAR%%pattern}`, `${VAR#pattern}`, `${VAR##pattern}`
- [ ] Command substitution: `$(...)` (nestable) and backtick `` `...` `` (not easily nestable)
- [ ] Process substitution (bash): `<(...)` and `>(...)` — operator before `(`
- [ ] Heredoc: `<<DELIM` — everything until a line containing only `DELIM` is the heredoc body
- [ ] Context-sensitivity: `if`, `then` etc. are only reserved words at the start of a command position; the lexer must track this or the parser must drive re-tokenisation

**Common bugs:**
```rust
// BUG: doesn't handle $() nesting
// Input: $(echo $(date))
// Naive lexer stops at first ) instead of tracking nesting depth

// BUG: heredoc not handled
// Input: cat <<EOF\nhello\nEOF
// Lexer must switch to heredoc mode after seeing <<DELIM

// BUG: word boundary not at operator
// Input: echo foo>bar  → should lex as: Word("echo") Word("foo") GREAT Word("bar")
// Not as: Word("echo") Word("foo>bar")
```

### Layer 3: Parser / AST Audit

The parser should produce a clean AST. Reference: `brush-parser` on docs.rs for a complete Rust shell AST.

**Expected AST node types:**
```rust
enum Command {
    Simple(SimpleCommand),           // echo foo > bar
    Pipeline(Vec<Command>),          // cmd1 | cmd2 | cmd3
    List(Vec<(Command, ListOp)>),    // cmd1 && cmd2 ; cmd3
    If(IfCommand),                   // if ... then ... else ... fi
    While(WhileCommand),             // while ... do ... done
    Until(UntilCommand),
    For(ForCommand),                 // for x in ...; do ... done
    Case(CaseCommand),               // case $x in pat) ... ;; esac
    Subshell(Vec<Command>),          // ( ... )
    BraceGroup(Vec<Command>),        // { ... }
    FunctionDef(String, Box<Command>),
}

struct SimpleCommand {
    assigns: Vec<(String, Word)>,    // FOO=bar before the command
    words: Vec<Word>,                // command name + args
    redirects: Vec<Redirect>,
}

enum Redirect {
    Input(Option<u32>, Word),        // [n]<file
    Output(Option<u32>, Word),       // [n]>file
    Append(Option<u32>, Word),       // [n]>>file
    HereDoc(Option<u32>, HereDoc),   // [n]<<DELIM
    // ... etc
}
```

**Audit checklist for the parser:**
- [ ] Pipeline: `|` separates commands; `|&` (bash: redirects stderr too)
- [ ] List: `;` (sequential), `&` (background), `&&` (and), `||` (or) — correct precedence?
- [ ] Compound commands properly terminated (fi, done, esac, `}`, `)`)
- [ ] Redirects can appear anywhere in a simple command, not just at the end
- [ ] Function definition syntax: `name() compound_command` or `function name { ... }` (bash)
- [ ] Empty command (just redirects or just assignments) is valid
- [ ] Subshell vs brace group: `(` needs space or is it a word? `{` requires space before content

### Layer 4: Word Expansion Audit

POSIX word expansion order — must be strictly followed:

```
1. Brace expansion         {a,b,c} → a b c           (bash extension, not POSIX)
2. Tilde expansion         ~/foo → /home/user/foo
3. Parameter expansion     $VAR, ${VAR:-default}
4. Command substitution    $(date), `date`
5. Arithmetic expansion    $((2 + 2))
6. Process substitution    <(cmd), >(cmd)             (bash extension)
7. Word splitting (IFS)    Split expanded result on IFS chars
8. Pathname expansion      Glob: *, ?, [abc], **       (expand in current dir)
9. Quote removal           Remove unquoted \, ', "
```

**Audit checklist for expansion:**
- [ ] `IFS` variable respected for word splitting (default: space, tab, newline)
- [ ] `IFS=` (empty) disables word splitting
- [ ] `"$@"` expands to each positional parameter as a separate word
- [ ] `"$*"` expands to all positional parameters joined by first char of IFS
- [ ] Glob patterns inside double quotes are NOT expanded (quote removal happens first in string, but glob only runs after)
- [ ] `set -f` / `set -o noglob` disables pathname expansion
- [ ] `set -u` / `set -o nounset` causes error on unset variable expansion
- [ ] Parameter expansion inside double quotes: `"${VAR}"` expands but doesn't word-split

### Layer 5: Process Management Audit

```rust
// Canonical pipeline spawn pattern
fn spawn_pipeline(commands: &[SimpleCommand]) -> Result<Vec<Child>, ShellError> {
    let mut children = Vec::new();
    let mut prev_stdout: Option<OwnedFd> = None;

    for (i, cmd) in commands.iter().enumerate() {
        let (read_end, write_end) = if i + 1 < commands.len() {
            let (r, w) = nix::unistd::pipe()?;
            (Some(r), Some(w))
        } else {
            (None, None)
        };

        let mut command = std::process::Command::new(&cmd.argv[0]);
        command.args(&cmd.argv[1..]);

        if let Some(stdin_fd) = prev_stdout.take() {
            command.stdin(unsafe { Stdio::from_raw_fd(stdin_fd.into_raw_fd()) });
        }
        if let Some(stdout_fd) = write_end {
            command.stdout(unsafe { Stdio::from_raw_fd(stdout_fd.into_raw_fd()) });
        }

        // Job control: each pipeline in its own process group
        let pgid = if children.is_empty() { 0 } else { children[0].id() };
        unsafe {
            command.pre_exec(move || {
                nix::unistd::setpgid(Pid::from_raw(0), Pid::from_raw(pgid as i32))
                    .map_err(|e| io::Error::from_raw_os_error(e as i32))?;
                Ok(())
            });
        }

        children.push(command.spawn()?);
        prev_stdout = read_end.map(OwnedFd::from);
    }
    Ok(children)
}
```

**Audit checklist for process management:**
- [ ] Pipeline: each stage connected via pipe; write end closed in parent after spawn
- [ ] File descriptors not leaked to child processes (set `CLOEXEC` or use `Command` which does this)
- [ ] Process groups: each pipeline creates a new `pgid`; first child sets it, subsequent children join
- [ ] Foreground: `tcsetpgrp(STDIN_FILENO, pgid)` transfers terminal control; restore to shell on completion
- [ ] Background: do NOT call `tcsetpgrp`; suppress SIGTTOU/SIGTTIN in background children
- [ ] `waitpid(WNOHANG)` in SIGCHLD handler to reap zombies; update job table
- [ ] `waitpid(WUNTRACED)` to detect `SIGTSTP` (Ctrl+Z) — update job state to Stopped
- [ ] Redirects applied after fork, before exec (in pre_exec hook)

### Layer 6: Signal Handling Audit

```rust
use signal_hook::iterator::Signals;
use signal_hook::consts::*;

fn setup_signal_handlers(job_tx: mpsc::Sender<JobEvent>) {
    let mut signals = Signals::new([SIGCHLD, SIGWINCH, SIGTERM, SIGHUP])?;
    thread::spawn(move || {
        for sig in signals.forever() {
            match sig {
                SIGCHLD  => reap_children(&job_tx),
                SIGWINCH => update_terminal_size(&job_tx),
                SIGTERM | SIGHUP => graceful_shutdown(),
                _ => {}
            }
        }
    });
}
```

**Signal audit checklist:**
- [ ] `SIGCHLD`: reap children with `waitpid(WNOHANG)` — loop until no more children to reap
- [ ] `SIGINT` (Ctrl+C): send to foreground process group, NOT to shell itself
- [ ] `SIGTSTP` (Ctrl+Z): send to foreground process group; shell suspends the job
- [ ] `SIGWINCH`: terminal resized — propagate new `winsize` via `ioctl(TIOCSWINSZ)` to PTY
- [ ] Shell itself: ignore `SIGTTOU`, `SIGTTIN`, `SIGTSTP` (shell is never stopped by terminal signals)
- [ ] `SIGHUP` on shell exit: send `SIGHUP` to all jobs (unless `disown`ed)
- [ ] Signal safety: signal handlers must only call async-signal-safe functions — don't allocate, don't use Mutex

---

## §2 — PTY Layer Reference

### PTY Setup (Unix)
```rust
use nix::pty::{openpty, Winsize};
use nix::fcntl::{fcntl, FcntlArg, OFlag};

fn create_pty(cols: u16, rows: u16) -> Result<(PtyMaster, PtySlave)> {
    let winsize = Winsize { ws_col: cols, ws_row: rows, ws_xpixel: 0, ws_ypixel: 0 };
    let pty = openpty(Some(&winsize), None)?;

    // Set CLOEXEC on master so child doesn't inherit it
    fcntl(pty.master.as_raw_fd(), FcntlArg::F_SETFD(nix::fcntl::FdFlag::FD_CLOEXEC))?;

    Ok((pty.master, pty.slave))
}

// In child process (pre_exec):
fn child_setup(slave_fd: RawFd) -> io::Result<()> {
    unsafe {
        // New session — child becomes session leader
        libc::setsid();
        // Slave becomes controlling terminal
        libc::ioctl(slave_fd, libc::TIOCSCTTY, 0);
        // Redirect stdin/stdout/stderr to slave
        libc::dup2(slave_fd, 0);
        libc::dup2(slave_fd, 1);
        libc::dup2(slave_fd, 2);
        // Close the slave fd (now duplicated to 0/1/2)
        libc::close(slave_fd);
    }
    Ok(())
}
```

### Cross-Platform (portable-pty)
```toml
[dependencies]
portable-pty = { git = "https://github.com/wez/wezterm", ... }
```
```rust
use portable_pty::{CommandBuilder, PtySize, native_pty_system};

let pty_system = native_pty_system();
let pair = pty_system.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })?;
let mut child = pair.slave.spawn_command(CommandBuilder::new("bash"))?;
let master = pair.master;
// Read from master to get terminal output
// Write to master to send input to child
```

### VT/ANSI Escape Sequence Parsing
```toml
[dependencies]
vte = "0.13"  # VT100/VT220/ANSI state machine parser
```
```rust
use vte::{Parser, Perform};

struct Screen { /* cells, cursor, ... */ }

impl Perform for Screen {
    fn print(&mut self, c: char) { /* write char to cell at cursor */ }
    fn execute(&mut self, byte: u8) {
        match byte {
            0x08 => { /* backspace */ }
            0x0D => { /* carriage return */ }
            0x0A => { /* newline */ }
            _ => {}
        }
    }
    fn csi_dispatch(&mut self, params: &Params, _intermediates: &[u8], _ignore: bool, action: char) {
        match action {
            'A' => { /* cursor up */ }
            'B' => { /* cursor down */ }
            'H' => { /* cursor position */ }
            'm' => { /* SGR: colors, bold, etc. */ }
            _ => {}
        }
    }
    // esc_dispatch, hook, put, osc_dispatch, ...
}

let mut parser = Parser::new();
let mut screen = Screen::new(80, 24);
parser.advance(&mut screen, byte);  // call for each byte from PTY master
```

---

## §3 — Crate Ecosystem for Shell/Terminal Work

| Layer | Crate | Notes |
|---|---|---|
| **PTY (Unix)** | `nix` | Low-level: openpty, forkpty, ioctl, winsize |
| **PTY (cross-platform)** | `portable-pty` | From WezTerm — Linux/macOS/Windows ConPTY |
| **PTY (pure Rust)** | `pseudoterminal` | Sync + async API |
| **Terminal I/O** | `crossterm` | Raw mode, events, ANSI codes — all platforms |
| **Terminal I/O (Unix-only)** | `termion` | Lighter alternative, Unix-only |
| **VT parser** | `vte` | ANSI/VT100/VT220 state machine |
| **VT + screen model** | `alacritty-terminal` | Full terminal emulation from Alacritty |
| **Shell lexer** | Hand-written | Most control; see §4 |
| **Shell lexer helper** | `logos` | DFA-based, very fast, attribute macros |
| **Parser combinator** | `nom` | Streaming-capable, good for incremental |
| **PEG parser** | `pest` | Grammar file + codegen; cleaner for complex grammars |
| **LR(1) parser** | `lalrpop` | Full parser generator; custom lexer via trait |
| **Process spawning** | `std::process` | Safe baseline for simple cases |
| **Unix process control** | `nix` | fork, exec, waitpid, setpgid, tcsetpgrp |
| **Signal handling** | `signal-hook` | Safe iterator-based signal handling |
| **Readline-like input** | `rustyline` | Line editing, history, completion |
| **Reference AST** | `brush-parser` | Complete POSIX shell AST — use as reference |

---

## §4 — Writing a POSIX Shell Lexer in Rust

### Token Definition
```rust
#[derive(Debug, Clone, PartialEq)]
pub enum Token {
    // Operators
    And,         // &
    AndIf,       // &&
    Pipe,        // |
    OrIf,        // ||
    Semicolon,   // ;
    DSemi,       // ;;
    Less,        // <
    Great,       // >
    DLess,       // <<
    DGreat,      // >>
    LessAnd,     // <&
    GreatAnd,    // >&
    LessGreat,   // <>
    DLessDash,   // <<-
    Clobber,     // >|
    LParen,      // (
    RParen,      // )
    LBrace,      // {
    RBrace,      // }
    Bang,        // !
    Newline,

    // Data tokens
    Word(WordParts),
    AssignmentWord(String, WordParts),  // NAME=value
    IoNumber(u32),                       // digit+ before < or >
    Name(String),

    // Reserved words (only reserved at command position)
    If, Then, Else, Elif, Fi,
    Do, Done, While, Until,
    For, In, Case, Esac,

    Eof,
}

// Word is made of parts (to support expansion later)
#[derive(Debug, Clone, PartialEq)]
pub enum WordPart {
    Literal(String),
    SingleQuoted(String),           // 'content'
    DoubleQuoted(Vec<WordPart>),    // "..." with nested expansions
    Parameter(ParamExpansion),      // $VAR or ${...}
    CommandSubst(Vec<Token>),       // $(...)  (store token stream for later)
    ArithExpansion(String),         // $((...))
    Glob(GlobPattern),              // *, ?, [...]
    Backslash(char),                // \c
}
```

### Lexer State Machine
```rust
pub struct Lexer<'a> {
    input: &'a str,
    chars: std::str::CharIndices<'a>,
    pos: usize,
    at_command_position: bool,  // for reserved word recognition
    pending_heredoc: Option<HereDocState>,
}

impl<'a> Iterator for Lexer<'a> {
    type Item = Result<Token, LexError>;

    fn next(&mut self) -> Option<Self::Item> {
        self.skip_whitespace_and_comments();

        match self.peek_char() {
            None => Some(Ok(Token::Eof)),
            Some('\n') => { self.advance(); Some(Ok(Token::Newline)) }
            Some('#') => { self.skip_to_newline(); self.next() }
            Some('\'') => Some(self.lex_single_quoted()),
            Some('"')  => Some(self.lex_double_quoted()),
            Some('$')  => Some(self.lex_dollar()),
            Some('`')  => Some(self.lex_backtick()),
            Some('<') | Some('>') | Some('|') | Some('&') | Some(';')
                       => Some(self.lex_operator()),
            Some('(')  => { self.advance(); Some(Ok(Token::LParen)) }
            Some(')')  => { self.advance(); Some(Ok(Token::RParen)) }
            Some('{')  => { self.advance(); Some(Ok(Token::LBrace)) }
            Some('}')  => { self.advance(); Some(Ok(Token::RBrace)) }
            Some('\\') => Some(self.lex_backslash()),
            _          => Some(self.lex_word()),
        }
    }
}
```

### Common Lexer Bugs to Check
```rust
// BUG: Off-by-one in string slicing with multi-byte chars
// Use char indices, not byte indices, for slicing
let slice = &input[start_byte..end_byte];  // OK if start/end are byte offsets from CharIndices

// BUG: Not tracking nesting depth for $() and ``
// $(echo $(date)) — inner ) must not close outer $(
fn lex_command_subst(&mut self) -> Result<Vec<Token>, LexError> {
    let mut depth = 1;
    // Increment depth on '(', decrement on ')', stop at depth=0
}

// BUG: Heredoc body read too eagerly or too late
// The heredoc body is read AFTER the current line's other tokens
// cat <<EOF | grep foo   ← valid POSIX — heredoc body is next input

// BUG: Treating 'if' as reserved word inside a word
// echo if    ← 'if' is a plain word here (not at command position)
// if true    ← 'if' IS a reserved word here
```

---

## §5 — Enhancement Opportunities (Common)

When auditing a shell emulator, these are the most common gaps to fill:

### High Priority
1. **Error recovery in the lexer/parser** — produce meaningful errors with position information (`miette` for display)
2. **Complete word expansion** — parameter expansion modifiers `${VAR:-default}` etc. are often missing
3. **Heredoc support** — commonly skipped in MVPs
4. **Job control completeness** — `fg`, `bg`, `jobs` builtins; SIGTSTP/SIGCONT handling
5. **Signal propagation** — SIGINT must go to foreground process group, not shell

### Medium Priority
6. **Glob expansion** — `*`, `?`, `[...]`, `**` (globstar); use `glob` crate or implement with `walkdir`
7. **History** — `rustyline` or manual readline with up/down arrows; `HISTFILE` persistence
8. **Tab completion** — filename completion via `rustyline` completion trait; command completion from `$PATH`
9. **Prompt customisation** — `PS1`, `PS2`; `\u`, `\h`, `\w` escapes; colour support
10. **`set` builtin** — `set -e` (errexit), `set -u` (nounset), `set -o pipefail` are essential for scripting

### Lower Priority
11. **Arithmetic expansion** — `$(( expr ))` with operator precedence parser
12. **Process substitution** — `<(cmd)` creates a named pipe or `/dev/fd/N`
13. **Brace expansion** — `{a,b,c}` and `{1..10}` (bash extension)
14. **`trap` builtin** — signal trapping in scripts
15. **`exec` builtin** — replace shell process with command

---

## §6 — Testing Strategy

```rust
// Test lexer against POSIX cases
#[test]
fn test_operator_recognition() {
    let tokens: Vec<_> = Lexer::new("cmd1 && cmd2 || cmd3").collect();
    assert_eq!(tokens[1], Ok(Token::AndIf));
    assert_eq!(tokens[3], Ok(Token::OrIf));
}

// Test quoting
#[test]
fn test_single_quote_preserves_everything() {
    let tokens: Vec<_> = Lexer::new("echo 'hello $world'").collect();
    // $world must be literal, not expanded
    let word = extract_word(&tokens[1]);
    assert!(matches!(word.parts[0], WordPart::SingleQuoted(s) if s == "hello $world"));
}

// Integration: compare against reference shell
// Run same command through your shell and through dash/bash --posix
// Compare exit codes and stdout
#[test]
fn test_pipeline_output() {
    let output = your_shell_exec("echo hello | tr a-z A-Z").unwrap();
    assert_eq!(output.stdout, "HELLO\n");
}

// Test conformance with the POSIX sh conformance suite (testregex, etc.)
// https://github.com/modernish/modernish — includes POSIX conformance tests
```

---

## §7 — Reference Implementations to Study

| Project | Language | Notes |
|---|---|---|
| **brush** | Rust | POSIX-compatible; `brush-parser` crate has public AST; best Rust reference |
| **fish shell** | Rust | Completed C++→Rust rewrite 2025; production quality |
| **nsh** | Rust | fish-like but bash-compatible; async init |
| **Alacritty** | Rust | GPU terminal emulator; best reference for VT/PTY layer |
| **WezTerm** | Rust | Terminal + multiplexer; `portable-pty` comes from here |
| **Zellij** | Rust | Terminal workspace; excellent PTY multiplexing reference |
| **dash** | C | Minimal POSIX sh; clean C reference for shell semantics |

Key docs:
- POSIX.1-2024 Shell grammar: https://pubs.opengroup.org/onlinepubs/9699919799/
- Bash reference manual: https://www.gnu.org/software/bash/manual/
- The TTY demystified: https://www.linusakesson.net/programming/tty/
