/** A small local page to try voice commands against without leaving localhost. */
export function demoPage(section: string): string {
  const pages: Record<string, { title: string; body: string }> = {
    home: {
      title: "Home",
      body: `<p>This is the built-in demo site. Try saying: <em>"click on pricing"</em>, <em>"type hello world in the search box and press enter"</em>, <em>"scroll down"</em>, <em>"go back"</em>, or <em>"open wikipedia dot org"</em>.</p>
        <p><a href="/demo?page=docs" class="cta">Read the docs</a> <a href="/demo?page=pricing" class="cta secondary">See pricing</a></p>`,
    },
    docs: { title: "Documentation", body: "<p>Docs live here. Say <em>\"go back\"</em> to return, or <em>\"click on contact\"</em>.</p>" },
    pricing: {
      title: "Pricing",
      body: `<div class="plans"><div class="plan"><h3>Hobby</h3><p>$0</p><button type="button" onclick="alert('Hobby selected')">Choose Hobby</button></div>
        <div class="plan"><h3>Pro</h3><p>$29</p><button type="button" onclick="alert('Pro selected')">Choose Pro</button></div>
        <div class="plan"><h3>Team</h3><p>$99</p><button type="button" onclick="alert('Team selected')">Choose Team</button></div></div>`,
    },
    blog: { title: "Blog", body: "<p>Nothing published yet.</p>" },
    contact: {
      title: "Contact",
      body: `<form onsubmit="event.preventDefault(); document.getElementById('sent').textContent='Message sent to ' + this.email.value">
        <label>Your name <input name="name" placeholder="Ada Lovelace"></label>
        <label>Email address <input name="email" type="email" placeholder="ada@example.com"></label>
        <label>Message <textarea name="message" placeholder="Say hello"></textarea></label>
        <button type="submit">Send message</button> <button type="button" class="danger" onclick="alert('Account deleted (not really)')">Delete account</button>
        <p id="sent" class="ok"></p></form>`,
    },
    search: { title: "Search results", body: `<p>You searched for <strong id="q"></strong>.</p><script>document.getElementById('q').textContent=new URLSearchParams(location.search).get('q')||''</script>` },
  };
  const page = pages[section] ?? pages.home!;
  const nav = ["home", "docs", "pricing", "blog", "contact"]
    .map((s) => `<a href="/demo?page=${s}"${s === section ? ' class="active"' : ""}>${pages[s]!.title}</a>`)
    .join("");
  const filler = Array.from({ length: 12 }, (_, i) => `<p class="filler">Section ${i + 1}: scroll me. Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Demo · ${page.title}</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;color:#1d2433;background:#fff}
header{display:flex;align-items:center;gap:20px;padding:14px 28px;border-bottom:1px solid #e3e6ea}
header .logo{font-weight:700}
nav a{margin-right:16px;color:#3b4a5e;text-decoration:none;padding:6px 2px}
nav a.active{color:#1a56db;border-bottom:2px solid #1a56db}
header form{margin-left:auto;display:flex;gap:6px}
input,textarea{font:inherit;padding:8px 10px;border:1px solid #c9cfd6;border-radius:6px}
button{font:inherit;padding:8px 14px;border-radius:6px;border:1px solid #1a56db;background:#1a56db;color:#fff;cursor:pointer}
button.danger{background:#c81e1e;border-color:#c81e1e}
main{max-width:860px;margin:0 auto;padding:32px 28px}
a.cta{display:inline-block;margin-right:10px;padding:10px 16px;border-radius:6px;background:#1a56db;color:#fff;text-decoration:none}
a.cta.secondary{background:#eef2f7;color:#1d2433}
.plans{display:flex;gap:16px}.plan{flex:1;border:1px solid #e3e6ea;border-radius:8px;padding:16px}
label{display:block;margin:10px 0}label input,label textarea{display:block;width:320px;margin-top:4px}
.filler{color:#6b7684;margin:38px 0}.ok{color:#0a7f3f}
footer{padding:24px 28px;border-top:1px solid #e3e6ea;color:#6b7684}
</style></head><body>
<header><span class="logo">Jev Demo</span><nav>${nav}</nav>
<form action="/demo" method="get"><input type="hidden" name="page" value="search"><input type="search" name="q" placeholder="Search the demo site" aria-label="Search"><button type="submit">Search</button></form></header>
<main><h1>${page.title}</h1>${page.body}${filler}<p id="bottom">You reached the bottom. Say <em>"scroll to top"</em>.</p></main>
<footer><a href="/demo?page=home">Back to home</a></footer></body></html>`;
}
