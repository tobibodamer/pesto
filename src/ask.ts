import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const form = document.querySelector("form")!;
const input = document.querySelector<HTMLInputElement>("#say")!;

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  input.value = "";
  void (text ? invoke("ask_submit", { text }) : invoke("ask_hide"));
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") void invoke("ask_hide");
});

// Clicking anywhere else puts the box away; what was typed stays for next time.
window.addEventListener("blur", () => void invoke("ask_hide"));

void listen("ask://shown", () => {
  input.focus();
  input.select();
});
