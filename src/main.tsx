import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// WebView2 기본 메뉴의 새로 고침, 인쇄 등을 막고 입력칸의 복사와 붙여넣기만 남깁니다.
document.addEventListener("contextmenu", (event) => {
  if (!(event.target as Element).closest("input, textarea")) {
    event.preventDefault();
  }
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
