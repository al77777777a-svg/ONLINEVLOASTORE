# VOLA Control

A control panel for your Railway bots. You see all bots on one page, as big colored tiles, and you can start, stop, restart, redeploy, read logs and change settings and variables without opening Railway.

It runs on **your own computer**. Nobody else can open it.

## What you can do

| Where | What |
| --- | --- |
| Front page | See every bot at once: green = online, red = crashed, yellow = building or starting, grey = stopped. Restart, Stop, Start and Redeploy one bot, or all bots at once. |
| Bot page, **Overview** | Status, code source, running version, public address, and the newest log lines. When a bot has crashed, it shows what to try. |
| **Logs** | Running log and build log. Search, show only warnings or errors, live mode, copy, download as a text file. |
| **Variables** | See the names, show a value only when you press the eye, change, add, delete, import a `.env` text. After a change the panel can redeploy for you. |
| **Settings** | Rename the bot, start command, build command, restart rule, number of copies, health check, timetable. Only the fields you changed are sent. |
| **Deployments** | Every version Railway built. Go back to an older version (roll back), cancel a build, remove an old one. |
| Activity (top bar) | A list of everything you did with this panel. Secret values are never written here. |

Every action that can hurt (Stop, Redeploy, Remove, Delete) asks first.

## Start it (Windows), 3 steps

1. **Install Node.js** one time: go to <https://nodejs.org> and install the **LTS** version. Use the default choices.
2. **Double-click `start.bat`.** A black window opens and your browser opens the panel at <http://localhost:3000>. Keep the black window open while you use the panel. Close it to stop the panel.
3. **First time only: the setup page asks two things.**
   - **A Railway token.** Open your project on Railway, then **Settings → Tokens**. Name it `VOLA Control`, choose the environment your bots use (normally `production`), press **Create**, and copy the token. Railway shows it only once. Paste it in the setup page and press **Check token**. You should see your 5 bots listed.
   - **A password for the panel.** At least 8 characters.

Next time you only double-click `start.bat` and sign in with your password.

macOS or Linux: open a terminal in this folder and run `./start.sh`.

## Try it without risk: demo mode

Double-click **`start-demo.bat`** (or run `./start.sh --demo`). The bots are pretend and nothing on Railway is touched. The password is `demo`. Use it to learn the buttons.

Try this: the bot `bc` starts crashed because its `DISCORD_TOKEN` is a placeholder. Open `bc`, go to **Variables**, change `DISCORD_TOKEN` to anything, keep "Redeploy the bot after saving" ticked, and watch the tile go yellow and then green.

## How to fix a crashed bot (real bots)

1. Open the bot and read **Overview → What to try**, then the **Logs** (the last red lines tell the reason).
2. Most crashes are a wrong or expired variable, for example `DISCORD_TOKEN`. Fix it in **Variables** (keep "Redeploy" ticked).
3. If the newest code is the problem, open **Deployments** and **Roll back** to the last version that worked.
4. Still red? Press **Restart**, or **Redeploy** to build again from GitHub.

## Safety

- The panel listens on `127.0.0.1` only, so other devices cannot reach it. It also checks the web address of every request to block attacks from other websites in your browser.
- Your Railway token is saved in the file `.env` in this folder. **Do not share this folder or the `.env` file.** A project token works for one project only, which limits the damage if it leaks. You can delete the token on Railway at any time.
- Your panel password is never saved as text. Only a one-way scrypt hash is kept, in the `data` folder.
- Six wrong passwords from one address lock sign-in for up to 15 minutes.
- Variable values stay hidden until you press the eye. They hide again after 30 seconds. They never go into the activity list.
- Every write needs a special header and a matching origin, so a web page you visit cannot press buttons for you.

## Things to know

- **Railway limits requests per hour** (about 100 on Free, 1000 on Hobby, 10000 on Pro). The panel asks Railway every 30 seconds, faster for a short time after you press a button, and not at all while the browser tab is hidden. **Settings → Check again** shows how many requests are left.
- A bot reads its variables only when it starts. After a change, redeploy.
- **Tested with a pretend Railway, not with your real project.** The 5 bots, every button, the setup page and the security checks were tested in demo mode, with a real browser. A real test needs your own Railway token, and only the owner of the project can create it. If something does not work on the first real try, open **Settings** in the panel: it shows each step (Railway answers, project found, bots found) with a plain message about what failed.
- Railway can change its API. The panel uses Railway's public GraphQL API (<https://docs.railway.com/integrations/api>).

## Options

Create or edit the file `.env` (a text file next to `server.js`). Every line is `NAME=value`.

| Name | Meaning | Default |
| --- | --- | --- |
| `RAILWAY_PROJECT_TOKEN` | Project token (written by the setup page) | |
| `RAILWAY_API_TOKEN` | Account or workspace token instead of a project token. Then also set both IDs below. | |
| `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID` | Only needed for an account token | already filled in |
| `PORT` | Web port | `3000` |
| `POLL_SECONDS` | How often to ask Railway (10 to 600) | `30` |
| `BIND_HOST` | Which address to listen on | `127.0.0.1` |
| `DATA_DIR` | Where the password hash and activity list are saved | `./data` |
| `DEMO` | `true` = always demo mode | |

## Put it on a server (not recommended)

It is safest on your own computer. If you still want it on a server, you must use HTTPS, and set `BIND_HOST=0.0.0.0`, `COOKIE_SECURE=true`, `TRUST_PROXY=true` (only behind a proxy you trust) and `ALLOWED_HOSTS=your.domain.com`. Then anyone on the internet can reach the sign-in page, so use a long password.

## For developers

- No packages to install. Node 18 or newer. The server uses only Node's built-in modules, the pages use plain JavaScript modules, and there is no build step.
- Run the tests: `node --test` (all use the pretend Railway).
- `lib/demo.js` is the pretend Railway. `lib/bots.js` turns Railway's answers into simple bot objects. `lib/documents.js` has every GraphQL document in one place.

## Fonts

The pages use Atkinson Hyperlegible Next and Atkinson Hyperlegible Mono by the Braille Institute, under the SIL Open Font License (see `public/fonts`).
