export interface NoticeAction {
  label: string;
  run: () => void;
}

/** A plain message box with optional buttons. Showing a new one replaces the old one. */
export function showNotice(text: string, actions: NoticeAction[] = []): HTMLElement {
  document.getElementById('notice')?.remove();
  const box = document.createElement('div');
  box.id = 'notice';
  box.setAttribute('role', 'alert');
  const message = document.createElement('p');
  message.textContent = text;
  box.appendChild(message);
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      box.remove();
      action.run();
    });
    box.appendChild(button);
  }
  document.body.appendChild(box);
  return box;
}
