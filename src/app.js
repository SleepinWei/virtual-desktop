import { parseHTML } from 'linkedom';

// Only this checked-in application runs. No uploaded scripts or arbitrary URLs.
export function createApplication(saved = {}) {
  const state = {
    draft: saved.draft ?? '',
    tasks: saved.tasks ?? [{ text: 'Verify client-side drawing', done: false }],
    count: saved.count ?? 0,
  };
  const { document, window } = parseHTML(`<!doctype html><html><body>
    <main id="app" style="padding:28px;gap:16px;background-color:#f0f4fa">
      <div style="flex-direction:row;align-items:center;justify-content:space-between;height:34px">
        <h1 style="font-size:24px;color:#14233b">Agent workspace</h1>
        <div style="font-size:13px;color:#61718b">DRAW COMMANDS / LOCAL PIXELS</div>
      </div>
      <p style="color:#53627a;font-size:15px">Page state runs in a server process. This picture is drawn on your device.</p>
      <section style="padding:20px;gap:12px;background-color:#ffffff;border-width:1px;border-color:#dce4ef;border-radius:12px">
        <h2 style="font-size:18px;color:#14233b">Task board</h2>
        <div style="flex-direction:row;gap:12px;height:42px">
          <input id="task-input" aria-label="New task" placeholder="Add a task for the agent" style="flex-grow:1;height:42px" />
          <button id="add-task" style="width:120px;height:42px;background-color:#2463eb;color:#ffffff">Add task</button>
        </div>
        <div id="task-list" style="gap:8px"></div>
        <div id="status" role="status" style="font-size:13px;color:#52637c">Ready</div>
      </section>
      <section style="padding:20px;gap:14px;background-color:#ffffff;border-width:1px;border-color:#dce4ef;border-radius:12px">
        <h2 style="font-size:18px;color:#14233b">Persistent session counter</h2>
        <div style="flex-direction:row;gap:12px;align-items:center;height:40px">
          <button id="increment" style="width:120px;height:40px">Increment</button>
          <span id="counter" style="font-size:24px;color:#2463eb"></span>
        </div>
        <div id="chart" data-chart="true" aria-label="Vector chart" style="height:76px;background-color:#f5f8ff;border-radius:8px"></div>
      </section>
      <p style="font-size:12px;color:#61718b">v0: trusted application + limited layout. General website compatibility is future work.</p>
    </main>
  </body></html>`);

  const input = document.querySelector('#task-input');
  input.value = state.draft;
  function renderTasks() {
    const list = document.querySelector('#task-list');
    list.replaceChildren();
    state.tasks.forEach((task, index) => {
      const row = document.createElement('div');
      row.setAttribute('style', 'flex-direction:row;gap:10px;align-items:center;height:36px');
      const button = document.createElement('button');
      button.id = `task-${index}`;
      button.textContent = task.done ? 'Done' : 'Open';
      button.setAttribute('style', `width:64px;height:32px;background-color:${task.done ? '#dcfce7' : '#eaf0ff'};color:#174234`);
      button.addEventListener('click', () => {
        task.done = !task.done;
        button.textContent = task.done ? 'Done' : 'Open';
        button.style.backgroundColor = task.done ? '#dcfce7' : '#eaf0ff';
        document.querySelector('#status').textContent = `Task ${index + 1} updated`;
      });
      const label = document.createElement('span');
      label.style.flexGrow = '1';
      label.textContent = task.text;
      row.append(button, label);
      list.append(row);
    });
  }
  input.addEventListener('input', () => { state.draft = input.value; });
  document.querySelector('#add-task').addEventListener('click', () => {
    const value = input.value.trim();
    if (!value) { document.querySelector('#status').textContent = 'Enter a task first'; return; }
    if (state.tasks.length >= 30) { document.querySelector('#status').textContent = 'Task limit: 30'; return; }
    state.tasks.push({ text: value, done: false });
    input.value = state.draft = '';
    renderTasks();
    document.querySelector('#status').textContent = `Added: ${value}`;
  });
  document.querySelector('#increment').addEventListener('click', () => {
    document.querySelector('#counter').textContent = String(++state.count);
  });
  document.querySelector('#counter').textContent = String(state.count);
  renderTasks();
  return { document, window, state, save: () => structuredClone(state) };
}
