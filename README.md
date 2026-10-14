# ScreenConnect Filter

A Chrome extension that filters ScreenConnect's own **Access** machine list. It needs no admin rights
and no Session Groups. Rows stay the normal, clickable ScreenConnect rows; the extension only hides the ones that don't match.

Filters:

- **Type**: Server / Desktop / Mac / Linux / Unknown (worked out from the OS name)
- **OS**: the exact OS name; the dropdown lists every OS in your estate
- **Status**: online or offline
- **Offline > N days**
- **Software contains…**: machines with a matching installed program (e.g. `sage`)
- **PowerShell check**: run any command that prints `True`/`False`, then keep the True, False or "no result" machines

All of these work together with ScreenConnect's own search box and the sidebar group you have selected.

## Install

1. Download this repo (green **Code** button → Download ZIP, then unzip it, or `git clone`).
2. In Chrome, go to `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the folder.
4. Open your ScreenConnect `https://<you>.screenconnect.com/Host` page. A **Filter** button appears in the bottom-right.

**One setting:** `ROOT` near the top of `content.js` must be your instance's top-level session group.
That's the first group in the Access sidebar, e.g. `All Machines`. It's set to `All Machines by Site`.

After changing any file, click reload ↻ on the extension in `chrome://extensions`, then refresh the ScreenConnect page.

Self-hosted (not `*.screenconnect.com`)? Add your address to `matches` in `manifest.json`.

## Use

Click **Filter** to open the panel. The basic filters (type, OS, status, offline days) apply instantly.
The button turns orange while any filter is on. **Clear** resets everything.

### Software search
Type a name in **Software contains…** and press Enter. This only *reads* software lists that ScreenConnect
already has. A machine has a list once someone has opened its **Software** tab, or once you've clicked **Scan software**.

**Scan software** sends ScreenConnect's own Software-tab inventory command to every **online Windows**
machine in the current view, after a confirm box that shows the machine count. That command is read-only.
It lists installed programs from the registry and changes nothing. Results come in over a minute or
two, and the list refreshes by itself. The status line shows `N match · M no result yet`.

### PowerShell check
1. Type a command that outputs `True` or `False`, for example:
   ```powershell
   [bool](Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue | Where-Object { $_.LocalPath -like '*\j.bloggs' })
   ```
2. Click **Run check**. It runs on every **online Windows** machine in the current view, after a confirm box.
3. Choose **True**, **False** or **No result** in the check dropdown. "No result" means the machine was
   offline, the command is still running, or the command errored.

Wrap the command in `[bool](...)` so it always prints True/False. For cmd commands, wrap them too,
e.g. `[bool](cmd /c "...")`.

⚠ **Run check runs YOUR command as SYSTEM on real machines.** Only run read-only checks unless you mean it.
Test on a small group first. Endpoint security (EDR/MDR) may alert on PowerShell recon run across many machines.

## How it works

ScreenConnect's web page refreshes its machine list every ~2 seconds by calling `SC.service.GetLiveData`.
The extension runs inside the page (`"world": "MAIN"`) and wraps that one function:

1. While a filter is on, it asks for the **whole** list instead of one page of it.
2. When the answer arrives, it drops the machines that don't match, then trims back to the page size ScreenConnect asked for.
3. ScreenConnect draws what's left as normal, so rows, clicks and the side panel all keep working.

Changing a filter forces an immediate refresh. Nothing is stored; reloading the page clears the filters.

**Software and PowerShell checks** use ScreenConnect's normal "run command" mechanism, the same thing
the Commands tab does:

- **Sending:** the command is added as a *QueuedCommand* event on each machine, in batches of 50, up to 500 per click.
- **Reading back:** each machine's output is saved in its history as a *RanCommand* event. The filter reads
  each machine's latest matching output. That's one request per machine, capped at 1,000 per refresh,
  8 at a time, and cached so it isn't re-fetched every 2 seconds.
- **Software** is read from the Software tab's own inventory output, so a scan also fills that tab.
- **PowerShell checks** print a marker line first (`SCFCHECK:` + a short hash of your command), then your
  command's output. The filter only trusts a True/False that follows *that* marker. Editing the
  command changes the marker, so you never see answers from an older command.

Only the two buttons, **Scan software** and **Run check**, send anything to machines, and both ask first.
Everything else is read-only and uses your existing logged-in ScreenConnect session; no passwords or keys are stored.

## Limits

- Only the main list is filtered; the sidebar group counts don't change.
- Software and check results only exist for machines that were online when you scanned or checked them.
- Software/check lookups are capped at 1,000 machines per refresh. Pick a site or add filters to narrow
  bigger views.
- It relies on ScreenConnect's internal page code. A ScreenConnect update could break it; if the button
  disappears, check the browser console (F12) for errors from `content.js`.
