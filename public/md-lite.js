// The few marks a model writes in nearly every reply — **bold**, *italic*,
// `code`, "- " bullets, "#" headings, ``` fences — drawn as what they mean
// instead of as asterisks and backticks. Found filming the bank-details demo:
// the claw's answer showed "**Sort Code:** 12-34-56" on screen, raw.
//
// The transcript renders model output, and the model reads strangers' pages,
// so nothing here is ever HTML: parse() returns plain tokens, and render()
// builds every node with createElement and createTextNode. A reply that says
// "<img src=x onerror=…>" shows those characters, exactly as before.
//
// Deliberately small. No links (a model-written link is a phishing link
// waiting to be clicked; the URL stays visible as text), no tables, no
// nesting. A mark that is not closed stays as typed, which is also what a
// half-streamed reply looks like until its closing mark arrives.
(function (root) {
  // `code` first, so marks inside it are left alone. Bold before italic, and
  // only **bold**: "__bold__" would eat Python's __init__.
  // Underscore emphasis only at word edges, so snake_case and file_names_like
  // _this survive; asterisk italic needs no space inside its edges, so
  // "2 * 3 * 4" stays arithmetic.
  var INLINE = /`([^`\n]+)`|\*\*(?=\S)([^*\n]*?\S)\*\*|\*(?=[^\s*])([^*\n]*?[^\s*])\*|(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g;

  function inline(text) {
    var out = [];
    var last = 0;
    var m;
    INLINE.lastIndex = 0;
    while ((m = INLINE.exec(text))) {
      var start = m.index;
      var lead = "";
      if (m[5] !== undefined) {
        // The underscore rule consumed the character before the mark.
        lead = m[4];
        start += lead.length;
      }
      if (start > last) out.push({ t: text.slice(last, start) });
      if (m[1] !== undefined) out.push({ t: m[1], code: true });
      else if (m[2] !== undefined) out.push({ t: m[2], b: true });
      else if (m[3] !== undefined) out.push({ t: m[3], i: true });
      else out.push({ t: m[5], i: true });
      last = INLINE.lastIndex;
    }
    if (last < text.length) out.push({ t: text.slice(last) });
    return out;
  }

  /** Lines of tokens: { kind: "p" | "li" | "h" | "code", lead, spans }. */
  function parse(text) {
    var lines = String(text || "").split("\n");
    var out = [];
    var fenced = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        continue; // the fence line itself is markup, not words
      }
      if (fenced) {
        out.push({ kind: "code", lead: "", spans: [{ t: line, code: true }] });
        continue;
      }
      var h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
      if (h) {
        out.push({ kind: "h", lead: "", spans: inline(h[1]) });
        continue;
      }
      var li = /^(\s*)(?:[-*+•])\s+(.*)$/.exec(line);
      if (li) {
        out.push({ kind: "li", lead: li[1] + "• ", spans: inline(li[2]) });
        continue;
      }
      out.push({ kind: "p", lead: "", spans: inline(line) });
    }
    return out;
  }

  /** The words a person reads: what copy() takes and what a test can compare. */
  function plain(text) {
    return parse(text)
      .map(function (l) { return l.lead + l.spans.map(function (s) { return s.t; }).join(""); })
      .join("\n");
  }

  /** Replace el's contents with text, drawn. el keeps white-space: pre-wrap. */
  function render(el, text) {
    var doc = el.ownerDocument;
    var nodes = [];
    var lines = parse(text);
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (i > 0) nodes.push(doc.createTextNode("\n"));
      var holder = l.kind === "h" ? doc.createElement("strong") : null;
      var target = [];
      if (l.lead) target.push(doc.createTextNode(l.lead));
      for (var j = 0; j < l.spans.length; j++) {
        var s = l.spans[j];
        var node;
        if (s.code) { node = doc.createElement("code"); node.textContent = s.t; }
        else if (s.b) { node = doc.createElement("strong"); node.textContent = s.t; }
        else if (s.i) { node = doc.createElement("em"); node.textContent = s.t; }
        else node = doc.createTextNode(s.t);
        target.push(node);
      }
      if (holder) {
        for (var k = 0; k < target.length; k++) holder.appendChild(target[k]);
        holder.className = "md-h";
        nodes.push(holder);
      } else {
        for (var n = 0; n < target.length; n++) nodes.push(target[n]);
      }
    }
    el.replaceChildren.apply(el, nodes);
  }

  root.MdLite = { parse: parse, plain: plain, render: render };
})(typeof window !== "undefined" ? window : globalThis);
