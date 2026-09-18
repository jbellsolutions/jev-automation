import { useState } from "react";

export function CommandInput({ onSubmit }: { onSubmit: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      className="text-form"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(text);
        setText("");
      }}
    >
      <input id="text-input" type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="…or type a command, e.g. open wikipedia.org" aria-label="Type a command" />
      <button type="submit">Go</button>
    </form>
  );
}
