# Financial Hub

A personal finance overview: income, fixed costs, subscriptions, budgets, savings goals, net worth and spending insights.
A static web app (hosted on GitHub Pages) that runs in the browser on your PC, Mac and phone.
You sign in with Google and your data is saved as one file in **your own Google Drive** (`financial-hub-data.json`).
The code is public; your data never is.

## How it works

- **Hosting:** GitHub Pages serves the HTML/CSS/JS. There's no server of our own.
- **Sign-in:** Google Identity Services gives the app a short-lived access token (~1 hour). After that, tap **Sign in** once.
- **Storage:** Google Drive API with the `drive.file` permission, so the app can only see the file it created itself.
- **Offline / not signed in:** the app shows the copy saved on the device and syncs once you sign in.
- **Two devices at once:** avoid it. If both changed, the most recent edit wins.

## One-time setup

1. Push this folder to a GitHub repository and enable **GitHub Pages** (Settings → Pages → deploy from branch `main`, root).
2. In [Google Cloud Console](https://console.cloud.google.com/): create a project, enable the **Google Drive API**,
   configure the OAuth consent screen (External, Testing, add yourself as test user), and create an
   **OAuth client ID** (Web application) with your Pages origin (e.g. `https://yourname.github.io`) as an authorised JavaScript origin.
3. Paste the client ID into `js/config.js`, commit and push.

## On your phone

Open the GitHub Pages address, sign in, then add it to your home screen:
- **iPhone:** Safari → Share → *Add to Home Screen*
- **Android:** Chrome → ⋮ → *Add to Home screen*

## Testing locally

Serve the folder over `http://localhost:<port>` (any static server) and add that origin to the OAuth client's
authorised JavaScript origins as well. Without a client ID the app still works, saving on that device only.

## Monthly routine (~5 minutes)

Open **Log month** and:
- fill in rough totals per variable category (groceries, eating out, …) from your banking app
- change a fixed amount only if it was different this month (e.g. a higher energy bill)
- add one-offs (tax refund, freelance job, big purchase)
- log what you moved to each savings goal
- note your account balances (bank, savings, investments, collectibles) for the net worth overview

**Raise or price increase?** Edit the item in *Fixed & subscriptions* and set "applies from". Earlier months keep the old amount.
**Cancelled a subscription?** Use **Stop**. It disappears from future months but stays in your history.

## How the code is organised

| File | What it does |
|---|---|
| `index.html` | Page skeleton: header, tabs, dialog |
| `styles.css` | All styling, including dark mode |
| `js/config.js` | Your Google client ID |
| `js/storage.js` | Saving: copy on the device + Google sign-in + Google Drive API |
| `js/calc.js` | The money math: which items count in which month, totals, goal progress |
| `js/charts.js` | Hand-made SVG bar charts with tooltips |
| `js/example.js` | Made-up example data |
| `js/app.js` | Screens, buttons, insights. The data format is documented at the top. |

Plain JavaScript, no build step and no dependencies, so it's easy to read and change.

## Backups

**Data & sync → Export backup** downloads a copy of everything. Google Drive also keeps version history of `finance-data.json`.

## Ideas for later

- Import bank CSV exports for automatic categorisation
- Net worth tracking (accounts, investments)
- Yearly overview / annual report
- Put the code in git and on GitHub (great next learning step)
