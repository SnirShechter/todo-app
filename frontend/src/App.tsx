import { useState, useEffect } from "react";
import "./App.css";

interface Todo {
  id: number;
  text: string;
  completed: boolean;
  created_at: string;
}

const API = "/api/todos";

function App() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [input, setInput] = useState("");

  const load = () => fetch(API).then((r) => r.json()).then(setTodos);

  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!input.trim()) return;
    await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: input.trim() }),
    });
    setInput("");
    load();
  };

  const toggle = async (t: Todo) => {
    await fetch(`${API}/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: !t.completed }),
    });
    load();
  };

  const remove = async (id: number) => {
    await fetch(`${API}/${id}`, { method: "DELETE" });
    load();
  };

  return (
    <div className="container">
      <h1>📝 Shared Todo</h1>
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
              <input type="checkbox" checked={t.completed} onChange={() => toggle(t)} />
              <span>{t.text}</span>
            </label>
            <button className="delete" onClick={() => remove(t.id)}>✕</button>
          </li>
        ))}
      </ul>
      {todos.length === 0 && <p className="empty">No todos yet. Add one above!</p>}
    </div>
  );
}

export default App;
