# Browser check: Contagion's tile page on its own and in a stand-in host (test/browser/host.html, which speaks the
# Game Host Kit's messages), in Chromium.
#   python test/browser/check_tile.py [folder for screenshots]
# Serves this folder on 127.0.0.1, plays whole games by clicking, saves them, and checks each saved record against
# the engine in Node. Screenshots at four sizes go to the screenshots folder.
import sys, os, json, time, subprocess, threading, http.server, socketserver
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "test", "browser", "screenshots")
os.makedirs(SHOTS, exist_ok=True)
ok = True
def check(name, cond, extra=""):
    global ok
    print(("PASS " if cond else "FAIL ") + name + (("  " + str(extra)) if extra else ""), flush=True)
    ok = ok and bool(cond)

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm"}
    def translate_path(self, path):
        return os.path.join(ROOT, path.split("?", 1)[0].lstrip("/"))
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(("127.0.0.1", 8794), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:8794"

def replay_in_node(record):
    out = subprocess.run(["node", os.path.join(ROOT, "test", "browser", "replay-record.mjs")], input=json.dumps(record), capture_output=True, text=True)
    return out.stdout.strip() or out.stderr.strip()

def play(f, bank_after=None, timeout=60):
    """Plays the game in frame/page f to the end: keeps the first type offered; banks after `bank_after` rolls."""
    rolls = 0
    t0 = time.time()
    while time.time() - t0 < timeout:
        if f.locator("#endPanel").is_visible():
            return True
        btns = f.locator("#below button[data-move]")
        if btns.count():
            moves = [btns.nth(i).get_attribute("data-move") for i in range(btns.count())]
            if "roll" in moves:
                m = "bank" if bank_after is not None and rolls >= bank_after else "roll"
                rolls += m == "roll"
            else:
                m = moves[0]
            try:
                f.locator(f'#below button[data-move="{m}"]').click(timeout=1500)
            except Exception:
                pass
        time.sleep(0.12)
    return False

with sync_playwright() as p:
    browser = p.chromium.launch()
    requests = []
    def watch(page):
        page.on("request", lambda r: requests.append(r.url))
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        return errors

    # ---- on its own, four sizes ----
    for (w, h, name) in [(380, 540, "tile"), (340, 300, "card"), (300, 250, "small-card"), (390, 844, "phone")]:
        pg = browser.new_page(viewport={"width": w, "height": h})
        errors = watch(pg)
        pg.goto(f"{BASE}/tile/index.html?seed=4242")
        pg.wait_for_selector("#rollBtn")
        pg.screenshot(path=os.path.join(SHOTS, f"{name}-start.png"))
        pg.click("#freeBtn")
        pg.click("#rollBtn")
        pg.wait_for_selector("#below button[data-move]", timeout=8000)
        pg.screenshot(path=os.path.join(SHOTS, f"{name}-keep.png"))
        # Everything inside the frame, nothing overflowing.
        box = pg.evaluate("""() => { const r = [...document.querySelectorAll('#app *')].filter((e) => e.offsetParent && !e.closest('#help')).map((e) => e.getBoundingClientRect());
          return { right: Math.max(...r.map((b) => b.right)), bottom: Math.max(...r.map((b) => b.bottom)), die: document.querySelector('.contagion-die').getBoundingClientRect().width }; }""")
        check(f"{name} {w}x{h}: fits the frame (dice {box['die']:.0f} px)", box["right"] <= w + 0.5 and box["bottom"] <= h + 0.5, box)
        if h < 400:
            beside = pg.evaluate("() => document.querySelector('#below').getBoundingClientRect().left >= document.querySelector('#grid').getBoundingClientRect().right")
            check(f"{name}: the buttons stand beside the grid", beside)
        check(f"{name}: plays to the end", play(pg))
        pg.screenshot(path=os.path.join(SHOTS, f"{name}-end.png"))
        check(f"{name}: no Save on its own", not pg.locator("#saveBtn").is_visible())
        check(f"{name}: no page errors", not errors, errors)
        pg.close()

    # ---- the pace (CT19): spin, red pulse, calm pulse; buttons hidden while they play ----
    pg = browser.new_page(viewport={"width": 380, "height": 540})
    watch(pg)
    # find a free seed whose opening roll has contamination
    pg.goto(f"{BASE}/tile/index.html?seed=4242")
    pg.click("#freeBtn")
    t0 = time.time()
    pg.click("#rollBtn")
    pg.wait_for_timeout(300)
    hidden_while_spinning = pg.locator("#below button[data-move]").count() == 0
    red = pg.wait_for_selector(".contagion-pulse-red", timeout=3000)
    t_red = time.time() - t0
    hidden_while_red = pg.locator("#below button[data-move]").count() == 0
    pg.wait_for_selector("#below button[data-move]", timeout=5000)
    t_keep = time.time() - t0
    check("pace: no buttons while the dice spin", hidden_while_spinning)
    check("pace: red pulse after the 1.2 s spin", 1.0 < t_red < 1.8, f"{t_red:.2f} s")
    check("pace: no buttons while contamination pulses", hidden_while_red)
    check("pace: keep buttons after spin + 2.4 s pulse", 3.3 < t_keep < 4.4, f"{t_keep:.2f} s")
    t1 = time.time()
    pg.locator("#below button[data-move]").first.click()
    pg.wait_for_timeout(200)
    hidden_while_calm = pg.locator("#below button[data-move]").count() == 0 and pg.locator(".contagion-pulse-calm-blue, .contagion-pulse-calm-yellow").count() > 0
    while time.time() - t1 < 4 and not (pg.locator("#below button[data-move]").count() or pg.locator("#endPanel").is_visible()):
        pg.wait_for_timeout(30)
    t_calm = time.time() - t1   # (the page's policy refuses Playwright's wait_for_function, so poll)
    check("pace: no buttons while a keep pulses", hidden_while_calm)
    check("pace: Roll again / Bank after a 1.6 s keep pulse", 1.4 < t_calm < 2.2, f"{t_calm:.2f} s")
    pg.close()

    ctx = browser.new_context(viewport={"width": 380, "height": 540}, reduced_motion="reduce")
    pg = ctx.new_page()
    pg.goto(f"{BASE}/tile/index.html?seed=4242")
    pg.click("#freeBtn")
    t0 = time.time()
    pg.click("#rollBtn")
    pg.wait_for_selector("#below button[data-move]", timeout=4000)
    t_still = time.time() - t0
    spins = pg.evaluate("() => getComputedStyle(document.querySelector('.contagion-die')).animationName")
    check("reduced motion: short still pauses, no spin", t_still < 1.4 and spins == "none", f"{t_still:.2f} s, {spins}")
    ctx.close()

    # ---- in the stand-in host ----
    def host_page(query="", w=900):
        pg = browser.new_page(viewport={"width": w, "height": 600})
        errors = watch(pg)
        pg.goto(f"{BASE}/test/browser/host.html{query}")
        f = pg.frame_locator("#game")
        f.locator("#rollBtn").wait_for()
        return pg, f, errors

    def save_yes(pg, f, answer="yes"):
        f.locator("#saveBtn").click()
        pg.wait_for_selector("#ask[open]")
        pg.click(f'#ask button[value="{answer}"]')

    pg, f, errors = host_page()
    check("host: Playing as @alice.example", f.locator("#who").inner_text() == "Playing as @alice.example")
    check("host: Daily is chosen, labelled with today", f.locator("#dayLabel").inner_text().startswith("Daily · "))
    f.locator("#rollBtn").click()
    check("host: a daily game plays to the end", play(f, bank_after=2))
    check("host: Save this game offered", f.locator("#saveBtn").is_visible())
    label = f.locator("#endLabel").inner_text()
    check("host: the end label is the engine's", label.startswith("Contagion · daily, "), label)
    save_yes(pg, f)
    f.locator("#seeBtn").wait_for()
    saved = pg.evaluate("window.saved")
    check("host: one daily record saved", len(saved) == 1 and saved[0]["record"]["mode"] == "daily" and "seed" not in saved[0]["record"], saved and saved[0]["record"])
    check("host: 'Saved to @alice.example's account ✓'", "Saved to @alice.example" in f.locator("#saveStatus").inner_text())
    check("host: the saved daily checks in Node", replay_in_node(saved[0]["record"]) == "ok")
    check("host: the record has no usedTypes and has its ending", "usedTypes" not in saved[0]["record"] and saved[0]["record"]["ending"] in ("bank", "emptied", "stuck"))
    f.locator("#seeBtn").click()
    pg.wait_for_function("window.opened")
    check("host: See it opens the saved record", pg.evaluate("window.opened") == saved[0]["uri"])

    # the nudge (CT16)
    f.locator("#againBtn").click()
    check("nudge: Play again after a daily starts free play", f.locator("#freeBtn").get_attribute("aria-pressed") == "true" and "free" in (f.locator("#board").get_attribute("class") or ""))
    check("nudge: the Daily button says it's played", f.locator("#dailyBtn").inner_text() == "Daily ✓")
    f.locator("#dailyBtn").click()
    check("nudge: Daily shows today's finished game", f.locator("#endPanel").is_visible() and f.locator("#endLabel").inner_text() == label)
    check("nudge: 'Today's daily: played'", "Today's daily: played" in f.locator("#hintRow").inner_text())
    check("nudge: no Roll for the daily again in this load", f.locator("#rollBtn").count() == 0)
    check("nudge: the saved daily shows See it, not Save", f.locator("#seeBtn").is_visible() and not f.locator("#saveBtn").is_visible())

    # free play saved
    f.locator("#againBtn").click()
    f.locator("#rollBtn").click()
    check("host: a free game plays to the end", play(f, bank_after=1))
    check("host: the end label says free play", f.locator("#endLabel").inner_text() == "Contagion · free play")
    save_yes(pg, f)
    f.locator("#seeBtn").wait_for()
    saved = pg.evaluate("window.saved")
    rec = saved[-1]["record"]
    check("host: a free-play record saved with its seed", len(saved) == 2 and rec["mode"] == "free" and isinstance(rec["seed"], int) and "day" not in rec)
    check("host: the saved free game checks in Node", replay_in_node(rec) == "ok")
    check("host: the host added $type, game and createdAt", rec["$type"] == "cafe.thunderbird.contagion.game" and rec["game"]["uri"].startswith("at://") and "createdAt" in rec)

    # declined
    f.locator("#againBtn").click()
    f.locator("#rollBtn").click()
    play(f, bank_after=0)
    save_yes(pg, f, "no")
    f.locator("#saveStatus").filter(has_text="Not saved.").wait_for()
    check("host: a declined save says 'Not saved.' and offers Save again", f.locator("#saveBtn").is_visible())

    # a tampered record is refused by the host's check
    tampered = dict(saved[-1]["record"])
    for k in ("$type", "game", "createdAt"): tampered.pop(k)
    tampered["score"] += 5
    f.locator("body").evaluate("""(body, r) => window.parent.postMessage({ source: 'contagion', kind: 'write-record', id: 'tamper-1', action: 'create', collection: 'cafe.thunderbird.contagion.game', record: r }, '*')""", tampered)
    pg.wait_for_function("window.messages.some((m) => m.id === 'tamper-1' && m.kind === 'write-record-result')")
    res = pg.evaluate("window.messages.find((m) => m.id === 'tamper-1' && m.kind === 'write-record-result')")
    check("host: a tampered score is refused as invalid", res.get("ok") is not True and res.get("error") == "invalid", (res, pg.evaluate("window.lastRefusal")))
    check("host: no page errors", not errors, errors)
    pg.screenshot(path=os.path.join(SHOTS, "host.png"))
    pg.close()

    # a host that saves other games but not Contagion
    pg, f, errors = host_page("?save=0")
    f.locator("#freeBtn").click()
    f.locator("#rollBtn").click()
    play(f, bank_after=0)
    check("save=0: no Save button", not f.locator("#saveBtn").is_visible())
    check("save=0: 'This page doesn't save Contagion games.'", f.locator("#saveNote").is_visible())
    pg.close()

    # no one signed in
    pg, f, errors = host_page("?who=none")
    check("guest: 'Playing as a guest'", f.locator("#who").inner_text() == "Playing as a guest")
    pg.close()

    # help
    pg = browser.new_page(viewport={"width": 300, "height": 250})
    pg.goto(f"{BASE}/tile/index.html")
    pg.click("#helpBtn")
    check("help: How to play opens", pg.locator("#help").is_visible() and "nothing you can keep" in pg.locator("#help").inner_text())
    pg.screenshot(path=os.path.join(SHOTS, "help-small.png"))
    pg.keyboard.press("Escape")
    check("help: Escape closes it", not pg.locator("#help").is_visible())
    pg.close()

    outside = [u for u in requests if not u.startswith(BASE)]
    check("nothing fetched from outside", not outside, outside[:5])
    browser.close()

print("ALL PASS" if ok else "SOME FAILED")
sys.exit(0 if ok else 1)
