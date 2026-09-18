async function startStripeCheckout() {
  if (!user?.email) {
    showAccountGate();
    return;
  }

  const button = $("#upgradeNow");
  const originalText = button.textContent;

  button.disabled = true;
  button.textContent = "Opening Stripe…";

  // Never show the old simulated checkout modal.
  $("#paymentModal").hidden = true;

  try {
    const response = await apiFetch("/create-checkout-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: user.email,
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data.error || "Stripe checkout could not be started.",
      );
    }

    if (!data.url || typeof data.url !== "string") {
      throw new Error(
        "The server did not return a Stripe checkout URL.",
      );
    }

    // Leave D50 and open the real Stripe-hosted checkout page.
    window.location.href = data.url;
  } catch (error) {
    alert(
      error.message || "Stripe checkout could not be started.",
    );

    button.disabled = false;
    button.textContent = originalText;
  }
}

$("#upgradeNow").onclick = startStripeCheckout;

async function resumeStripeCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  const checkoutStatus = params.get("checkout");

  if (!checkoutStatus || !sessionToken) {
    return false;
  }

  try {
    // Remove Stripe's return parameters from the address bar.
    window.history.replaceState(
      {},
      document.title,
      window.location.pathname,
    );

    /*
     * Stripe can redirect back slightly before the webhook finishes.
     * Check the authenticated account several times so the dashboard
     * receives the updated Premium status.
     */
    const attempts = checkoutStatus === "success" ? 8 : 1;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const response = await apiFetch("/api/auth/me");

      if (!response.ok) {
        throw new Error("Your account session has expired.");
      }

      user = await response.json();

      if (checkoutStatus !== "success" || user.paid) {
        break;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 750);
      });
    }

    showApp();
    await load();

    if (checkoutStatus === "success") {
      alert(
        user.paid
          ? "Payment verified. D50 Premium is active for 30 days."
          : "Stripe received your payment. Premium is still processing; refresh shortly.",
      );
    }

    return true;
  } catch (error) {
    alert(error.message || "Your payment status could not be loaded.");
    return false;
  }
}

setInterval(() => {
  if (user?.adminMode === "master" && !document.hidden) {
    syncPendingUploads();
  }
}, 3000);

resumeStripeCheckoutReturn().then((resumed) => {
  if (!resumed) {
    startAsGuest();
  }
});