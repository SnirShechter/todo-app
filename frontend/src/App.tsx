import { useState, useEffect, useCallback } from "react";
import { initAuth, login, logout, getUser, getAccessToken, isAuthenticated } from "./auth";
import "./App.css";

interface Todo {
  id: number;
  text: string;
  completed: boolean;
  created_at: string;
}

/** Fetch wrapper that adds Authorization header */
async function apiFetch(path: string, opts: RequestInit = {}) {
  const token = await getAccessToken();
  if (!token) throw new Error("No token");
  return fetch(path, {
    ...opts,
    headers: {
      ...opts.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

function App() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [input, setInput] = useState("");

  // Initialize auth on mount
  useEffect(() => {
    initAuth().then((ok) => {
      setAuthed(ok || isAuthenticated());
      setReady(true);
    });
  }, []);

  const loadTodos = useCallback(async () => {
    try {
      const res = await apiFetch("/api/todos");
      if (res.ok) setTodos(await res.json());
      else if (res.status === 401) {
        setAuthed(false);
      }
    } catch {}
  }, []);

  // Load todos when authenticated
  useEffect(() => {
    if (authed) loadTodos();
  }, [authed, loadTodos]);

  const add = async () => {
    if (!input.trim()) return;
    await apiFetch("/api/todos", {
      method: "POST",
      body: JSON.stringify({ text: input.trim() }),
    });
    setInput("");
    loadTodos();
  };

  const toggle = async (t: Todo) => {
    await apiFetch(`/api/todos/${t.id}`, {
      method: "PATCH",
      body: JSON.stringify({ completed: !t.completed }),
    });
    loadTodos();
  };

  const remove = async (id: number) => {
    await apiFetch(`/api/todos/${id}`, { method: "DELETE" });
    loadTodos();
  };

  if (!ready) {
    return (
      <div className="container">
        <p className="empty">Loading...</p>
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="container">
        <h1>📝 Todo</h1>
        <div className="login-box">
          <p>Sign in to manage your todos</p>
          <button onClick={login} className="login-btn">
            Sign In →
          </button>
        </div>
      </div>
    );
  }

  const user = getUser();

  return (
    <div className="container">
      <div className="header">
        <h1>📝 Todo</h1>
        <div className="user-info">
          <span className="user-name">{user?.name || user?.email}</span>
          <button onClick={logout} className="logout-btn">
            Sign Out
          </button>
        </div>
      </div>
      <div className="add-row">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="What needs to be done?"
          autoFocus
        />
        <button onClick={add}>Add</button>
      </div>
      <ul className="todo-list">
        {todos.map((t) => (
          <li key={t.id} className={t.completed ? "done" : ""}>
            <label>
              <input
                type="checkbox"
                checked={t.completed}
                onChange={() => toggle(t)}
              />
              <span>{t.text}</span>
            </label>
            <button className="delete" onClick={() => remove(t.id)}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      {todos.length === 0 && (
        <p className="empty">No todos yet. Add one above!</p>
      )}
    </div>
  );
}

export default App;
