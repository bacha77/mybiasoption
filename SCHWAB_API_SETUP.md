# 🦅 Charles Schwab API Setup Guide (BIAS Integration)

Welcome to the professional level. To connect your **BIAS Strategy Engine** to your real Charles Schwab account for automatic execution or advanced data, follow these steps exactly.

---

### 1️⃣ Register a Developer Account
*   Go to: [developer.schwab.com](https://developer.schwab.com/)
*   Click **"Register"** in the top right.
*   **Important:** This is a *separate* login from your brokerage account. Use a unique password.

### 2️⃣ Create Your Trading Application
Once logged in:
*   Navigate to **"Dashboard"** (at the top).
*   Click **"Create New App"**.
*   **App Name:** `BIAS_System` (or anything you like).
*   **Callback URL:** `https://127.0.0.1` (Required for the security handshake).
*   **API Selection (CRITICAL):**
    *   ✅ **Accounts and Trading Production**
    *   ✅ **Market Data Production**
*   **Order Limit:** You can set this to `10` or `20` (maximum trades per minute).

### 3️⃣ The Approval Period (The "Waiting Room")
*   After submitting, your app status will be **"Approved - Pending"**.
*   **Wait 3 to 5 Business Days.** Charles Schwab manually reviews these apps.
*   Once approved, the status will change to **"Ready for Use"**.

### 4️⃣ Retrieve Special Access Keys
Click on your approved app to see:
*   **App Key (Client ID):** This identifies your BIAS software to Schwab.
*   **App Secret (Client Secret):** This acts as the secure password for the software.

---

### 🛑 SAFETY INSTRUCTIONS:
1.  **NEVER** share your App Key or App Secret with anyone.
2.  **NEVER** hardcode them into your files.
3.  Once you have them, we will add them to your `.env` file like this:
    ```env
    SCHWAB_CLIENT_ID=your_app_key_here
    SCHWAB_CLIENT_SECRET=your_app_secret_here
    ```
4.  Adding them to `.env` ensures they are **ignored by Git** and stay safe and private.

---

### 🚀 What Happens Next?
Once these keys are added, your **BIAS Simulation Trader** can be swapped for a **Live Schwab Trader**, and your "Gold Standard" signals will hit your real portfolio.

**Last Updated:** 2026-03-04
**Project:** mybiasoption
