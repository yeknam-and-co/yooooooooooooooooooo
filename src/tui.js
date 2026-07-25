import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { EventEmitter } from "node:events";

export const tuiEvents = new EventEmitter();

export const COMMANDS = [
  { name: "/help", desc: "Show available commands" },
  { name: "/status", desc: "Show connection status" },
  { name: "/doctor", desc: "Diagnose the reply round-trip" },
  { name: "/mcp", desc: "Show MCP URL and setup status" },
  { name: "/mcp done", desc: "Mark MCP setup complete" },
  { name: "/webhooks", desc: "List active webhooks" },
  { name: "/webhook create", params: "<when> | <do what>", desc: "Create a webhook trigger" },
  { name: "/webhook fire", params: '<#> {"data":...}', desc: "Fire a webhook with JSON data" },
  { name: "/clear", desc: "Clear the chat" },
  { name: "/logout", desc: "Clear saved config and quit" },
];

const h = React.createElement;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ACCENT = "#7B68EE";

const THINKING_WORDS = [
  "Poking around", "Checking my notes", "Asking the palm tree",
  "Surfing the waves", "On it", "Digging in", "Cooking up a reply",
  "Reaching out to the universe", "Looking into it", "Brewing thoughts",
  "Catching a vibe", "Consulting the coconuts", "Adventuring",
  "Figuring it out", "Putting it together", "Almost there",
  "Exploring options", "Connecting the dots", "Reading the vibes",
  "One sec", "Hang tight", "Working on it", "Crunching it",
  "Fetching an answer", "Assembling words", "Crafting a reply",
  "Poking the clouds", "Channeling island energy", "Sipping and thinking",
  "Vibing with it", "Letting it marinate", "Piecing it together",
];

function pickWord() {
  return THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];
}

function filterCommands(input) {
  if (!input.startsWith("/")) return [];
  const q = input.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(q) || c.name.includes(q.slice(1)));
}

function Banner({ userName }) {
  return h(Box, { flexDirection: "column", paddingX: 1, marginTop: 1, marginBottom: 1 },
    h(Text, { bold: true, color: ACCENT }, "  🌴 Poke"),
    h(Text, { dimColor: true }, "  your AI assistant in the terminal"),
    h(Text, { dimColor: true }, "  by Interaction Company of California"),
    h(Text, null),
    userName
      ? h(Text, null, `  Welcome back, ${userName}!`)
      : null,
    h(Text, { dimColor: true }, "  Type a message to chat · / for commands"),
  );
}

function ThinkingIndicator() {
  const [frame, setFrame] = useState(0);
  const [word, setWord] = useState(pickWord);
  const [secs, setSecs] = useState(0);

  useEffect(() => {
    const spin = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 80);
    const swap = setInterval(() => setWord(pickWord()), 3000);
    const tick = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => {
      clearInterval(spin);
      clearInterval(swap);
      clearInterval(tick);
    };
  }, []);

  return h(Box, { paddingX: 1, marginTop: 1 },
    h(Text, { color: "yellow" }, `* ${SPINNER[frame]} `),
    h(Text, { dimColor: true }, `${word}… (${secs}s · esc to dismiss)`),
  );
}

function Message({ role, text, meta }) {
  if (role === "you") {
    return h(Box, { paddingX: 1, marginTop: 1, width: "100%" },
      h(Text, { wrap: "wrap" },
        h(Text, { bold: true }, "❯ "),
        text,
      ),
    );
  }

  if (role === "poke") {
    return h(Box, { paddingX: 1, marginTop: 1, flexDirection: "column", width: "100%" },
      h(Text, null,
        h(Text, { dimColor: true }, "● "),
        h(Text, { color: ACCENT, bold: true }, "poke"),
      ),
      h(Box, { paddingLeft: 2 },
        h(Text, { wrap: "wrap" }, text),
      ),
    );
  }

  if (role === "command") {
    return h(Box, { paddingX: 1, marginTop: 1, flexDirection: "column" },
      h(Box, null,
        h(Text, { color: "green" }, "● "),
        h(Text, { bold: true }, text),
        meta ? h(Text, { dimColor: true }, `  ${meta}`) : null,
      ),
    );
  }

  if (role === "result") {
    return h(Box, { paddingX: 1, paddingLeft: 3 },
      h(Text, { dimColor: true }, "└ "),
      h(Text, { dimColor: true }, text),
    );
  }

  if (role === "link") {
    const url = typeof text === "object" && text ? text.url : text;
    const label =
      typeof text === "object" && text ? text.label || "Click here" : text;
    const linkText = `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;
    return h(Box, { paddingX: 1, paddingLeft: 3 },
      h(Text, { dimColor: true }, "└ "),
      h(Text, null, linkText),
    );
  }

  if (role === "error") {
    return h(Box, { paddingX: 1, marginTop: 1, flexDirection: "column" },
      h(Box, null,
        h(Text, { color: "red" }, "● "),
        h(Text, { color: "red", bold: true }, "error"),
      ),
      h(Box, { paddingLeft: 3 },
        h(Text, { color: "red" }, `└ ${text}`),
      ),
    );
  }

  return h(Box, { paddingX: 1, paddingLeft: 3 },
    h(Text, { dimColor: true }, `· ${text}`),
  );
}

function CommandSuggestions({ matches, selected }) {
  if (matches.length === 0) return null;

  return h(Box, { flexDirection: "column", paddingX: 3, marginTop: 1, marginBottom: 1 },
    ...matches.slice(0, 8).map((cmd, i) =>
      h(Box, { key: cmd.name },
        h(Text, {
          color: i === selected ? ACCENT : undefined,
          bold: i === selected,
          dimColor: i !== selected,
        }, i === selected ? "› " : "  "),
        h(Text, {
          color: i === selected ? ACCENT : undefined,
          bold: i === selected,
        }, cmd.name),
        cmd.params
          ? h(Text, { dimColor: true }, ` ${cmd.params}`)
          : null,
        h(Text, { dimColor: true }, `  ${cmd.desc}`),
      )
    ),
    h(Text, { dimColor: true }, "  tab complete · ↑↓ select · enter run"),
  );
}

function App() {
  const { exit } = useApp();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [connected, setConnected] = useState(false);
  const [userName, setUserName] = useState(null);
  const [selected, setSelected] = useState(0);
  const [inputEpoch, setInputEpoch] = useState(0);
  const idRef = useRef(0);
  const selectedRef = useRef(0);
  const matchesRef = useRef([]);
  const thinkingRef = useRef(false);

  const matches = useMemo(() => filterCommands(input), [input]);

  useEffect(() => {
    setSelected(0);
  }, [input]);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    matchesRef.current = matches;
  }, [matches]);

  useEffect(() => {
    thinkingRef.current = thinking;
  }, [thinking]);

  const completeCommand = useCallback((cmd) => {
    setInput(cmd.name + " ");
    setInputEpoch((n) => n + 1);
  }, []);

  const nextId = useCallback(() => `msg-${++idRef.current}`, []);

  const push = useCallback((role, text, meta) => {
    setMessages((prev) => [...prev.slice(-100), { role, text, meta, id: nextId() }]);
  }, [nextId]);

  useEffect(() => {
    const onMsg = (role, text) => {
      push(role, text);
      if (role === "you") setThinking(true);
      if (role === "poke") setThinking(false);
    };
    const onSys = (text) => push("system", text);
    const onCmd = (text, meta) => push("command", text, meta);
    const onResult = (text) => push("result", text);
    const onLink = (payload) => push("link", payload);
    const onErr = (text) => { push("error", text); };
    const onConn = (v) => setConnected(v);
    const onThink = (v) => setThinking(v);
    const onQuit = () => exit();
    const onUser = (name) => setUserName(name);
    const onClear = () => setMessages([]);

    tuiEvents.on("message", onMsg);
    tuiEvents.on("system", onSys);
    tuiEvents.on("command", onCmd);
    tuiEvents.on("result", onResult);
    tuiEvents.on("link", onLink);
    tuiEvents.on("error", onErr);
    tuiEvents.on("connected", onConn);
    tuiEvents.on("thinking", onThink);
    tuiEvents.on("quit", onQuit);
    tuiEvents.on("user-name", onUser);
    tuiEvents.on("clear", onClear);

    return () => {
      tuiEvents.off("message", onMsg);
      tuiEvents.off("system", onSys);
      tuiEvents.off("command", onCmd);
      tuiEvents.off("result", onResult);
      tuiEvents.off("link", onLink);
      tuiEvents.off("error", onErr);
      tuiEvents.off("connected", onConn);
      tuiEvents.off("thinking", onThink);
      tuiEvents.off("quit", onQuit);
      tuiEvents.off("user-name", onUser);
      tuiEvents.off("clear", onClear);
    };
  }, [push, exit]);

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") {
      tuiEvents.emit("user-quit");
      exit();
      return;
    }

    // ponytail: hides the spinner only — the reply still arrives via MCP.
    // Real cancel would mean dropping the next reply_to_terminal payload.
    if (key.escape) {
      if (thinkingRef.current) setThinking(false);
      return;
    }

    if (matches.length === 0) return;

    if (key.upArrow) {
      setSelected((s) => (s - 1 + matches.length) % matches.length);
      return;
    }
    if (key.downArrow) {
      setSelected((s) => (s + 1) % matches.length);
      return;
    }
    if (key.tab) {
      const pick = matches[selected] || matches[0];
      if (pick) completeCommand(pick);
    }
  });

  const handleSubmit = (value) => {
    let text = value.trim();
    if (!text) return;

    const currentMatches = matchesRef.current;
    if (text.startsWith("/") && currentMatches.length > 0) {
      const pick = currentMatches[selectedRef.current] || currentMatches[0];
      if (pick) {
        const afterName = text.startsWith(pick.name)
          ? text.slice(pick.name.length).trim()
          : "";
        const needsArgs = Boolean(pick.params);
        if (needsArgs && !afterName) {
          completeCommand(pick);
          return;
        }
        if (!text.startsWith(pick.name)) {
          text = pick.name;
        }
      }
    }

    setInput("");
    setInputEpoch((n) => n + 1);
    tuiEvents.emit("user-input", text);
  };

  const visible = messages.slice(-50);
  const cols = process.stdout.columns || 80;

  return h(Box, { flexDirection: "column", width: "100%" },
    h(Banner, { userName }),

    h(Box, { flexDirection: "column", flexGrow: 1 },
      ...visible.map((msg) =>
        h(Message, { key: msg.id, role: msg.role, text: msg.text, meta: msg.meta })
      ),
      thinking && h(ThinkingIndicator, { key: "thinking" }),
    ),

    h(Box, { paddingX: 1 },
      h(Text, { dimColor: true }, "─".repeat(Math.max(10, cols - 2))),
    ),

    h(Box, { paddingX: 1, width: "100%", flexDirection: "row" },
      h(Box, { flexShrink: 0 },
        h(Text, { color: ACCENT, bold: true }, "❯ "),
      ),
      h(Box, { flexGrow: 1 },
        h(TextInput, {
          key: `input-${inputEpoch}`,
          value: input,
          onChange: (v) => setInput(v.replace(/\t/g, "")),
          onSubmit: handleSubmit,
          placeholder: "Ask Poke anything…  or type /",
        }),
      ),
    ),

    matches.length > 0 && h(CommandSuggestions, { matches, selected }),

    h(Box, { paddingX: 1, justifyContent: "space-between" },
      h(Text, { dimColor: true },
        h(Text, { color: connected ? "green" : "yellow" }, connected ? "● " : "○ "),
        connected ? "connected" : "connecting",
      ),
      h(Text, { dimColor: true }, "esc dismiss · / commands · ctrl-c quit"),
    ),
  );
}

export function startTUI() {
  process.stdout.write("\x1B[2J\x1B[3J\x1B[H");
  return render(h(App));
}
