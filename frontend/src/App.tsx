import { useState, useEffect } from "react";
import "./App.css";

interface Todo {
  id: number;
  text: string;
  completed: boolean;
  created_at: string;
}

interface User {
  sub: string;
  email: string;
  name: string;
}

const API = "/api/todos";

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [input, setInput] = useState("");

  // Check auth on mount
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => {
        setUser(u);
        setLoading(false);
        if (u) loadTodos();
      })
      .catch(() => setLoading(false));
  }, []);

  const loadTodos = () =>
    fetch(API)
      .then((r) => r.json())
      .then(setTodos);

  const add = async () => {
    if (!input.trim()) return;
    await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: input.trim() }),
    });
    setInput("");
    loadTodos();
  };

  const toggle = async (t: Todo) => {
    await fetch(`${API}/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: !t.completed }),
    });
    loadTodos();
  };

  const remove = async (id: number) => {
    await fetch(`${API}/${id}`, { method: "DELETE" });
    loadTodos();
  };

  if (loading) {
    return (
      <div className="container">
        <p className="empty">Loading...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="container">
        <h1>📝 Todo</h1>
        <div className="login-box">
          <p>Sign in to manage your todos</p>
          <a href="/api/auth/login" className="login-btn">
            Sign In →
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="header">
        <h1>📝 Todo</h1>
        <div className="user-info">
          <span className="user-name">{user.name || user.email}</span>
          <a href="/api/auth/logout" className="logout-btn">
            Sign Out
          </a>
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
