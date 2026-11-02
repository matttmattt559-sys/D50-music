"use strict";
fetch("/api/legal/contact", { cache: "no-store" })
  .then(async (response) => {
    if (!response.ok) throw new Error("Legal contact address has not been configured yet.");
    return response.json();
  })
  .then(({ email }) => {
    const link = document.getElementById("legalContactEmail");
    link.textContent = email;
    link.href = `mailto:${email}?subject=D50%20legal%20notice`;
    link.hidden = false;
    document.getElementById("legalContactStatus").textContent = "Email D50 legal contact:";
  })
  .catch(() => {
    document.getElementById("legalContactStatus").textContent =
      "The legal contact address is temporarily unavailable. Please use the in-app Report button for a song.";
  });
