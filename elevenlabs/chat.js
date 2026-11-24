/* Kaaf Studio AI chat assistant: lead hand-off.
 *
 * The ElevenLabs chat widget (<elevenlabs-convai agent-id="agent_5701...">) runs the
 * conversation. When the visitor has confirmed their project summary, the assistant calls
 * the client tool "submit_lead". This script handles that call: it emails the lead to the
 * studio through Web3Forms (the same service as the contact form, which allows sending
 * from the browser) and, on the demo page, shows the lead card.
 *
 * Used on the homepage chat bubble and on demos/ai-agent. Open the demo page with ?mock
 * to test the card and the email path without a conversation.
 */
(function () {
  "use strict";

  var WEB3FORMS_KEY = "4f9aa1bd-371f-4ceb-9240-938bab38d320";
  var MOCK = /[?&]mock\b/.test(location.search);
  var slot = document.getElementById("lead-slot"); // only on the demo page
  var sent = {}; // guards against the same lead being sent twice

  var PROJECT = {
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

  // Values come from the AI, so keep them short and plain before showing or sending them.
  function clean(v, max) {
    return String(v == null ? "" : v).replace(/[\u0000-\u0008\u000B-\u001F]/g, " ").trim().slice(0, max);
  }

  function showCard(o, status, ok) {
    if (!slot) return;
    slot.textContent = "";
    var box = el("div", "receipt");
    box.appendChild(el("h2", null, "Lead summary"));
    box.appendChild(el("p", "sub", "As Kaaf Studio receives it · " + o.score.toUpperCase() + " lead"));
    var dl = el("dl");
    [["Name", o.name], ["Email", o.email], ["Business", o.business], ["Project", o.project],
     ["Goal", o.goal], ["Features", o.features], ["Timeline", o.timeline], ["Budget", o.budget],
     ["Summary", o.summary]].forEach(function (r) {
      dl.appendChild(el("dt", null, r[0]));
      dl.appendChild(el("dd", null, r[1] || "-"));
    });
    box.appendChild(dl);
    box.appendChild(el("p", "status " + (ok ? "ok" : "bad"), status));
    slot.appendChild(box);
    box.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  async function sendEmail(o) {
    if (MOCK) { await new Promise(function (r) { setTimeout(r, 500); }); return; }
    var res = await fetch("https://api.web3forms.com/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        access_key: WEB3FORMS_KEY,
        subject: "New " + o.score.toUpperCase() + " lead from the AI chat: " + (o.business || o.name || "website visitor"),
        from_name: "Kaaf Studio AI assistant",
        replyto: o.email,
        name: o.name, email: o.email, business: o.business, project: o.project,
        goal: o.goal, features: o.features, timeline: o.timeline, budget: o.budget,
        lead_score: o.score, summary: o.summary,
        botcheck: false
      })
    });
    var out = await res.json().catch(function () { return {}; });
    if (!res.ok || out.success === false) throw new Error("email failed");
  }

  // The tool the chat agent calls. Its name must match the tool in the ElevenLabs dashboard.
  async function submitLead(params) {
    params = params || {};
    var score = clean(params.lead_score, 8).toLowerCase();
    var o = {
      name: clean(params.name, 60),
      email: clean(params.email, 100),
      business: clean(params.business, 160),
      project: PROJECT[clean(params.project_type, 30)] || clean(params.project_type, 30),
      goal: clean(params.goal, 240),
      features: clean(params.features, 240),
      timeline: clean(params.timeline, 80),
      budget: clean(params.budget, 80),
      score: ["hot", "warm", "cold"].indexOf(score) > -1 ? score : "warm",
      summary: clean(params.summary, 600)
    };
    if (!o.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.email)) {
      return "The lead was not sent: the name or the email address is missing or not valid. Ask the visitor for it and try again.";
    }
    var key = [o.name, o.email, o.summary].join("|");
    if (sent[key]) return "This lead was already sent. Do not send it again.";
    showCard(o, "Sending to Kaaf Studio…", true);
    try {
      await sendEmail(o);
      sent[key] = true;
      showCard(o, "Sent to Kaaf Studio ✓", true);
      return "The lead was sent to Kaaf Studio successfully.";
    } catch (e) {
      showCard(o, "Could not send. Please try again.", false);
      return "Sending the lead failed. Apologise and offer to try again, or to email kaafstudioai@gmail.com.";
    }
  }

  // Give the widget our tool when a conversation starts.
  var widget = document.querySelector("elevenlabs-convai");
  if (widget) {
    widget.addEventListener("elevenlabs-convai:call", function (event) {
      event.detail.config.clientTools = { submit_lead: submitLead };
    });
  }

  if (MOCK) {
    var btn = document.getElementById("testbtn");
    if (btn) {
      btn.hidden = false;
      btn.addEventListener("click", function () {
        submitLead({
          name: "Alex Example", email: "alex@example.com",
          business: "Brightside Cafe, a neighbourhood cafe", project_type: "booking_or_ordering",
          goal: "Get more local customers and take online orders",
          features: "Menu, online ordering, Google Maps", timeline: "Within 6 weeks",
          budget: "1,000 to 3,000 euros", lead_score: "hot",
          summary: "Cafe owner wants a new website with an online menu and pickup ordering to win more local customers. Clear budget and timeline."
        });
      });
    }
  }
})();
