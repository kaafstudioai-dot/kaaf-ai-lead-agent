/* Kaaf Studio project assistant: chat page.
 *
 * The page keeps the whole conversation (including Claude's own content blocks,
 * passed back unchanged) and sends it to the Cloudflare Worker on every turn.
 * When Claude calls submit_lead, the page shows the lead card; only when the
 * visitor presses "Send to Kaaf Studio" does the lead go to the studio inbox
 * through Web3Forms (the same service as the site's contact form).
 *
 * Open the page with ?mock to test the flow without the Worker or an API key.
 */
(function () {
  "use strict";

  // Paste the Worker's address here after deploying it, e.g.
  // "https://kaaf-lead-agent.your-name.workers.dev"
  var AGENT_URL = "";
  var WEB3FORMS_KEY = "4f9aa1bd-371f-4ceb-9240-938bab38d320";
  var GREETING = "Hi! I'm Kaaf Studio's assistant. I can help you plan a website or an AI assistant for your business. What does your business do?";

  var MOCK = /[?&]mock\b/.test(location.search);

  var log = document.getElementById("log");
  var form = document.getElementById("composer");
  var input = document.getElementById("input");
  var sendBtn = document.getElementById("send");
  var chips = document.getElementById("chips");
  var statusEl = document.getElementById("status");
  var restartBtn = document.getElementById("restart");

  var messages = [];      // conversation sent to the Worker
  var pendingTool = null; // a submit_lead tool_use waiting for its tool_result
  var busy = false;

  var PROJECT_LABELS = {
    new_website: "New website", redesign: "Redesign", online_store: "Online store",
    booking_or_ordering: "Booking or ordering", ai_agent: "AI agent",
    marketing: "Marketing", other: "Other"
  };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function scrollDown() { log.scrollTop = log.scrollHeight; }
  function bubble(kind, text) { var b = el("div", "msg " + kind, text); log.appendChild(b); scrollDown(); return b; }

  function setBusy(on) {
    busy = on;
    sendBtn.disabled = on;
    input.disabled = on;
    if (!on) input.focus({ preventScroll: true });
  }

  var typingEl = null;
  function showTyping(on) {
    if (on && !typingEl) {
      typingEl = el("div", "typing");
      typingEl.setAttribute("aria-label", "Assistant is typing");
      typingEl.innerHTML = "<i></i><i></i><i></i>";
      log.appendChild(typingEl); scrollDown();
    } else if (!on && typingEl) { typingEl.remove(); typingEl = null; }
  }

  function reset() {
    messages = [];
    pendingTool = null;
    log.textContent = "";
    chips.hidden = false;
    bubble("bot", GREETING);
    if (!AGENT_URL && !MOCK) {
      statusEl.textContent = "Offline";
      statusEl.classList.add("off");
      bubble("note", "The live assistant is being set up. Please check back soon, or contact Kaaf Studio at kaafstudioai@gmail.com.");
    }
  }

  // The greeting is shown to the visitor; Claude learns it from the first turn.
  function withGreeting(list) {
    if (!list.length) return list;
    var first = list[0];
    var text = typeof first.content === "string" ? first.content : null;
    if (text == null) return list;
    var copy = list.slice();
    copy[0] = { role: "user", content: "(The assistant greeted me with: \"" + GREETING + "\")\n\n" + text };
    return copy;
  }

  async function callAgent() {
    if (MOCK) return mockAgent(messages);
    var res = await fetch(AGENT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: withGreeting(messages) })
    });
    var data = null;
    try { data = await res.json(); } catch (e) { /* handled below */ }
    if (!res.ok || !data || !Array.isArray(data.content)) {
      throw new Error((data && data.error) || "The assistant couldn't be reached. Please try again.");
    }
    return data;
  }

  async function turn() {
    setBusy(true);
    showTyping(true);
    try {
      var data = await callAgent();
      showTyping(false);
      messages.push({ role: "assistant", content: data.content });
      data.content.forEach(function (b) {
        if (b.type === "text" && b.text.trim()) bubble("bot", b.text.trim());
      });
      var tool = data.content.filter(function (b) { return b.type === "tool_use" && b.name === "submit_lead"; })[0];
      if (tool) { pendingTool = tool; leadCard(tool); }
    } catch (err) {
      showTyping(false);
      // Drop the failed user turn so the visitor can try again cleanly.
      var last = messages[messages.length - 1];
      if (last && last.role === "user") messages.pop();
      bubble("note", err.message || "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // A visitor message. If a lead card is waiting, its tool_result goes first.
  function userTurn(text, toolNote) {
    var content;
    if (pendingTool) {
      content = [{ type: "tool_result", tool_use_id: pendingTool.id, content: toolNote || "The visitor did not send the lead yet and wrote a new message instead." }];
      if (text) content.push({ type: "text", text: text });
      pendingTool = null;
    } else {
      content = text;
    }
    messages.push({ role: "user", content: content });
    return turn();
  }

  function leadCard(tool) {
    var d = tool.input || {};
    var card = el("div", "lead");
    card.appendChild(el("h2", null, "Your project summary"));
    var score = String(d.lead_score || "warm");
    card.appendChild(el("span", "score " + (["hot", "warm", "cold"].indexOf(score) > -1 ? score : "warm"), score + " lead"));
    var dl = el("dl");
    [
      ["Name", d.name], ["Email", d.email], ["Business", d.business],
      ["Project", PROJECT_LABELS[d.project_type] || d.project_type], ["Goal", d.goal],
      ["Features", Array.isArray(d.features) ? d.features.join(", ") : d.features],
      ["Timeline", d.timeline], ["Budget", d.budget]
    ].forEach(function (row) {
      if (!row[1]) return;
      dl.appendChild(el("dt", null, row[0]));
      dl.appendChild(el("dd", null, String(row[1])));
    });
    card.appendChild(dl);
    if (d.summary) card.appendChild(el("p", null, String(d.summary)));

    var actions = el("div", "lead-actions");
    var send = el("button", "primary", "Send to Kaaf Studio");
    send.type = "button";
    var edit = el("button", "ghost", "Change something");
    edit.type = "button";
    actions.appendChild(send);
    actions.appendChild(edit);
    card.appendChild(actions);
    log.appendChild(card);
    scrollDown();

    send.addEventListener("click", async function () {
      if (busy) return;
      send.disabled = true; edit.disabled = true;
      send.textContent = "Sending…";
      try {
        await deliverLead(d);
        send.textContent = "Sent ✓";
        await userTurn(null, "The visitor confirmed and the lead was sent to Kaaf Studio. Thank them in one or two sentences.");
      } catch (e) {
        send.disabled = false; edit.disabled = false;
        send.textContent = "Send to Kaaf Studio";
        bubble("note", "Sending failed. Please try again, or email kaafstudioai@gmail.com.");
      }
    });
    edit.addEventListener("click", function () {
      if (busy) return;
      send.disabled = true; edit.disabled = true;
      userTurn("I'd like to change something in the summary.", "The visitor wants to change the summary before sending.");
    });
  }

  async function deliverLead(d) {
    if (MOCK) { await new Promise(function (r) { setTimeout(r, 600); }); return; }
    var score = String(d.lead_score || "").toUpperCase();
    var payload = {
      access_key: WEB3FORMS_KEY,
      subject: "New " + score + " lead from the AI assistant: " + (d.business || d.name || "website visitor"),
      from_name: "Kaaf Studio AI assistant",
      replyto: d.email,
      name: d.name, email: d.email, business: d.business,
      project: PROJECT_LABELS[d.project_type] || d.project_type,
      goal: d.goal,
      features: Array.isArray(d.features) ? d.features.join(", ") : d.features,
      timeline: d.timeline, budget: d.budget,
      lead_score: d.lead_score, summary: d.summary,
      botcheck: false
    };
    var res = await fetch("https://api.web3forms.com/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload)
    });
    var out = await res.json().catch(function () { return {}; });
    if (!res.ok || out.success === false) throw new Error("send failed");
  }

  function submitText(text) {
    text = text.trim();
    if (!text || busy) return;
    if (!AGENT_URL && !MOCK) { bubble("note", "The live assistant isn't switched on yet."); return; }
    chips.hidden = true;
    bubble("me", text);
    input.value = "";
    autosize();
    userTurn(text);
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  }

  form.addEventListener("submit", function (e) { e.preventDefault(); submitText(input.value); });
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitText(input.value); }
  });
  chips.addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (b) submitText(b.textContent);
  });
  restartBtn.addEventListener("click", function () { if (!busy) reset(); });

  // ---- Test mode: a scripted stand-in for the Worker (open the page with ?mock) ----
  var MOCK_SCRIPT = [
    "Nice! What would you like help with: a new website, a redesign, online ordering, or an AI assistant?",
    "Got it. What's the main goal: more customers, more bookings, or saving time?",
    "Which features are must-haves for you?",
    "When would you like it ready, and do you have a rough budget? For example under €1,000, €1,000–3,000 or €3,000–8,000.",
    "Thanks! Last thing: what's your name and email, so Kashaf can send you a free quote and sample?"
  ];
  function mockAgent(list) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        var last = list[list.length - 1];
        if (Array.isArray(last.content) && last.content[0] && last.content[0].type === "tool_result") {
          resolve({ content: [{ type: "text", text: "Thank you! Kashaf will be in touch within 24 hours with a free quote and a sample design." }] });
          return;
        }
        var userTurns = list.filter(function (m) { return m.role === "user"; }).length;
        if (userTurns <= MOCK_SCRIPT.length) {
          resolve({ content: [{ type: "text", text: MOCK_SCRIPT[userTurns - 1] }] });
        } else {
          resolve({ content: [
            { type: "text", text: "Here's a summary of your project. Does it look right?" },
            { type: "tool_use", id: "toolu_mock" + userTurns, name: "submit_lead", input: {
              name: "Alex Example", email: "alex@example.com", business: "Brightside Café, a neighbourhood café",
              project_type: "new_website", goal: "Get more local customers and take online orders",
              features: ["Menu", "Online ordering", "Google Maps"], timeline: "Within 6 weeks",
              budget: "€1,000–3,000", lead_score: "hot",
              summary: "Café owner wants a new website with an online menu and pickup ordering to win more local customers. Clear budget and timeline."
            } }
          ] });
        }
      }, 700);
    });
  }

  if (MOCK) { statusEl.textContent = "Test mode"; }
  reset();
})();
