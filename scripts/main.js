/**
 * RawBe Photography — site logic.
 * Vanilla JS, no dependencies. Runs with `defer`, so the DOM is ready.
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* Config                                                              */
  /* ------------------------------------------------------------------ */

  var CAROUSEL_TAG = "portfolio-carousel";
  var CAROUSEL_INTERVAL_MS = 5000;

  var ICONS = {
    rings: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 28" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="18" cy="14" r="12"/><circle cx="38" cy="14" r="12"/></svg>',
    family: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2" width="44" height="44" rx="3"/><circle cx="14" cy="18" r="5"/><path d="M4 44c0-8 10-10 10-10s10 2 10 10"/><circle cx="34" cy="18" r="5"/><path d="M24 44c0-8 10-10 10-10s10 2 10 10"/></svg>',
    microphone: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 52" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="1" width="14" height="24" rx="7"/><path d="M4 24a12 12 0 0 0 24 0"/><line x1="16" y1="36" x2="16" y2="48"/><line x1="10" y1="48" x2="22" y2="48"/></svg>',
  };

  // Fallback gallery sections, used only if data/nostr.json can't be loaded.
  // The live section list comes from data/nostr.json ("sections") so the
  // upload page and the renderer share one source of truth; the carousel
  // section (CAROUSEL_TAG) is excluded from the gallery grid.
  var DEFAULT_GALLERY_SECTIONS = [
    { tag: "wedding", title: "Weddings" },
    { tag: "family", title: "Family" },
    { tag: "portrait", title: "Portraits" },
    { tag: "maternity", title: "Maternity" },
  ];

  /* ------------------------------------------------------------------ */
  /* Data                                                                */
  /* ------------------------------------------------------------------ */

  function fetchJson(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error("Failed to load " + url + " (" + res.status + ")");
      return res.json();
    });
  }

  function postsWithTag(posts, tag) {
    return posts.filter(function (p) {
      return p.url && p.tags && p.tags.indexOf(tag) !== -1;
    });
  }

  function altText(post) {
    var caption = (post.caption || "").replace(/#[\p{L}\p{N}_]+/gu, "").trim();
    if (!caption) return "Photograph by RawBe Photography";
    return caption.length > 120 ? caption.slice(0, 117) + "..." : caption;
  }

  /** Section list shared with the upload page (data/nostr.json is the source of truth). */
  function deriveSections(nostrConfig) {
    var sections = nostrConfig && nostrConfig.sections;
    if (!sections || !sections.length) return DEFAULT_GALLERY_SECTIONS;
    return sections
      .filter(function (s) {
        return s.tag && s.tag !== CAROUSEL_TAG;
      })
      .map(function (s) {
        return { tag: s.tag, title: s.title || s.tag };
      });
  }

  /**
   * If an image URL dies (e.g. a Blossom server goes down), retry the post's
   * mirrored copies on other servers, in order.
   */
  function attachMirrorFallback(img, post) {
    var fallbacks = (post.mirrors || []).slice();
    if (!fallbacks.length) return;
    img.addEventListener("error", function () {
      var next = fallbacks.shift();
      if (next && img.src !== next) img.src = next;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Hero carousel                                                       */
  /* ------------------------------------------------------------------ */

  function initCarousel(posts) {
    var root = document.getElementById("hero-carousel");
    var track = root.querySelector(".carousel-track");
    var dotsWrap = root.querySelector(".carousel-dots");
    var prevBtn = root.querySelector(".carousel-prev");
    var nextBtn = root.querySelector(".carousel-next");

    if (!posts.length) {
      root.classList.add("carousel-empty");
      prevBtn.hidden = true;
      nextBtn.hidden = true;
      dotsWrap.hidden = true;
      return;
    }

    var index = 0;
    var timer = null;

    posts.forEach(function (post, i) {
      var slide = document.createElement("div");
      slide.className = "carousel-slide" + (i === 0 ? " is-active" : "");
      var img = document.createElement("img");
      img.src = post.url;
      img.alt = altText(post);
      attachMirrorFallback(img, post);
      if (i > 0) img.loading = "lazy";
      slide.appendChild(img);
      track.appendChild(slide);

      var dot = document.createElement("button");
      dot.className = "carousel-dot" + (i === 0 ? " is-active" : "");
      dot.type = "button";
      dot.setAttribute("aria-label", "Go to photo " + (i + 1));
      dot.addEventListener("click", function () {
        goTo(i);
        restart();
      });
      dotsWrap.appendChild(dot);
    });

    var slides = track.children;
    var dots = dotsWrap.children;

    function goTo(i) {
      slides[index].classList.remove("is-active");
      dots[index].classList.remove("is-active");
      index = (i + slides.length) % slides.length;
      slides[index].classList.add("is-active");
      dots[index].classList.add("is-active");
    }

    function next() {
      goTo(index + 1);
    }

    function restart() {
      if (timer) clearInterval(timer);
      if (slides.length > 1) timer = setInterval(next, CAROUSEL_INTERVAL_MS);
    }

    prevBtn.addEventListener("click", function () {
      goTo(index - 1);
      restart();
    });
    nextBtn.addEventListener("click", function () {
      next();
      restart();
    });

    // Pause auto-rotation while the visitor hovers the carousel.
    root.addEventListener("mouseenter", function () {
      if (timer) clearInterval(timer);
    });
    root.addEventListener("mouseleave", restart);

    // Basic touch swipe for mobile.
    var touchStartX = null;
    root.addEventListener(
      "touchstart",
      function (e) {
        touchStartX = e.changedTouches[0].clientX;
      },
      { passive: true }
    );
    root.addEventListener(
      "touchend",
      function (e) {
        if (touchStartX === null) return;
        var delta = e.changedTouches[0].clientX - touchStartX;
        if (Math.abs(delta) > 40) {
          if (delta < 0) next();
          else goTo(index - 1);
          restart();
        }
        touchStartX = null;
      },
      { passive: true }
    );

    if (slides.length < 2) {
      prevBtn.hidden = true;
      nextBtn.hidden = true;
      dotsWrap.hidden = true;
    }
    restart();
  }

  /* ------------------------------------------------------------------ */
  /* Galleries + lightbox                                                */
  /* ------------------------------------------------------------------ */

  var lightbox = {
    el: document.getElementById("lightbox"),
    img: document.querySelector(".lightbox-image"),
    caption: document.querySelector(".lightbox-caption"),
    posts: [],
    index: 0,
    fallbacks: [],

    open: function (posts, i) {
      this.posts = posts;
      this.show(i);
      this.el.hidden = false;
      document.body.classList.add("lightbox-open");
    },
    show: function (i) {
      this.index = (i + this.posts.length) % this.posts.length;
      var post = this.posts[this.index];
      this.fallbacks = (post.mirrors || []).slice();
      this.img.src = post.url;
      this.img.alt = altText(post);
      this.caption.textContent = altText(post);
    },
    close: function () {
      this.el.hidden = true;
      this.img.src = "";
      document.body.classList.remove("lightbox-open");
    },
  };

  function initLightbox() {
    lightbox.img.addEventListener("error", function () {
      var next = lightbox.fallbacks.shift();
      if (next && lightbox.img.src !== next) lightbox.img.src = next;
    });
    document.querySelector(".lightbox-close").addEventListener("click", function () {
      lightbox.close();
    });
    document.querySelector(".lightbox-prev").addEventListener("click", function () {
      lightbox.show(lightbox.index - 1);
    });
    document.querySelector(".lightbox-next").addEventListener("click", function () {
      lightbox.show(lightbox.index + 1);
    });
    lightbox.el.addEventListener("click", function (e) {
      if (e.target === lightbox.el) lightbox.close();
    });
    document.addEventListener("keydown", function (e) {
      if (lightbox.el.hidden) return;
      if (e.key === "Escape") lightbox.close();
      if (e.key === "ArrowLeft") lightbox.show(lightbox.index - 1);
      if (e.key === "ArrowRight") lightbox.show(lightbox.index + 1);
    });
  }

  function renderGalleries(posts, sections) {
    var container = document.getElementById("portfolio");

    sections.forEach(function (section) {
      var sectionPosts = postsWithTag(posts, section.tag);
      if (!sectionPosts.length) return; // hide empty sections entirely

      var el = document.createElement("section");
      el.className = "gallery";
      el.id = "gallery-" + section.tag;

      var title = document.createElement("h2");
      title.className = "section-title";
      title.textContent = section.title;
      el.appendChild(title);

      var grid = document.createElement("div");
      grid.className = "masonry";

      sectionPosts.forEach(function (post, i) {
        var figure = document.createElement("figure");
        figure.className = "masonry-item";
        var img = document.createElement("img");
        img.src = post.url;
        img.alt = altText(post);
        attachMirrorFallback(img, post);
        img.loading = "lazy";
        figure.appendChild(img);
        figure.addEventListener("click", function () {
          lightbox.open(sectionPosts, i);
        });
        grid.appendChild(figure);
      });

      el.appendChild(grid);
      container.appendChild(el);
    });

    if (!container.children.length) {
      var empty = document.createElement("p");
      empty.className = "galleries-empty";
      empty.textContent = "Portfolio coming soon.";
      container.appendChild(empty);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Contact form                                                        */
  /* ------------------------------------------------------------------ */

  function initContactForm() {
    var form = document.getElementById("contact-form");
    if (!form) return;
    var status = document.getElementById("contact-status");
    var submitBtn = form.querySelector("button[type=submit]");

    function showStatus(text, ok) {
      status.textContent = text;
      status.hidden = false;
      status.classList.toggle("contact-status-ok", ok);
      status.classList.toggle("contact-status-err", !ok);
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();

      var name        = (form.querySelector('[name="name"]').value || "").trim();
      var email       = (form.querySelector('[name="email"]').value || "").trim();
      var sessionType = (form.querySelector('[name="session_type"]').value || "").trim();
      var message     = (form.querySelector('[name="message"]').value || "").trim();
      var honeypot    = (form.querySelector('[name="website"]').value || "").trim();

      if (honeypot) return; // bot

      var subject = "New inquiry: " + (sessionType || "general") + " \u2014 " + name;
      var body = [
        "Name: " + name,
        "Email: " + email,
        "Session type: " + (sessionType || "(not specified)"),
        "",
        "Message:",
        message,
      ].join("\n");

      var mailtoUrl =
        "mailto:rawbephotography970@gmail.com" +
        "?subject=" + encodeURIComponent(subject) +
        "&body=" + encodeURIComponent(body);
      var gmailUrl =
        "https://mail.google.com/mail/?view=cm" +
        "&to=" + encodeURIComponent("rawbephotography970@gmail.com") +
        "&su=" + encodeURIComponent(subject) +
        "&body=" + encodeURIComponent(body);

      var link = document.createElement("a");
      link.href = mailtoUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // If the page still has focus after a short delay, no email client
      // opened — fall back to Gmail in the browser.
      setTimeout(function () {
        if (document.hasFocus()) {
          window.open(gmailUrl, "_blank", "noopener");
          showStatus("Opening Gmail in a new tab\u2014just hit Send!", true);
        } else {
          showStatus("Your email client should be open and ready to send!", true);
        }
      }, 600);

      showStatus("Your email client should open with the message ready to send!", true);
      submitBtn.textContent = "Opening email\u2026";
      setTimeout(function () {
        submitBtn.textContent = "Send Message";
      }, 3000);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Pricing                                                             */
  /* ------------------------------------------------------------------ */

  function renderPricing(data) {
    var grid = document.getElementById("pricing-grid");
    (data.packages || []).forEach(function (pkg) {
      var card = document.createElement("article");
      card.className = "pricing-card" + (pkg.highlighted ? " pricing-card-highlighted" : "");

      var name = document.createElement("h3");
      name.className = "pricing-name";
      name.textContent = pkg.name;
      card.appendChild(name);

      var price = document.createElement("p");
      price.className = "pricing-price";
      price.textContent = pkg.price;
      card.appendChild(price);

      if (pkg.description) {
        var desc = document.createElement("p");
        desc.className = "pricing-description";
        desc.textContent = pkg.description;
        card.appendChild(desc);
      }

      var list = document.createElement("ul");
      list.className = "pricing-features";
      (pkg.features || []).forEach(function (feature) {
        var li = document.createElement("li");
        li.textContent = feature;
        list.appendChild(li);
      });
      card.appendChild(list);

      var cta = document.createElement("a");
      cta.className = "btn btn-secondary";
      cta.href = "#contact";
      cta.textContent = "Book Now";
      card.appendChild(cta);

      grid.appendChild(card);
    });

    var additionalServices = data.additionalServices || [];
    if (additionalServices.length) {
      var addGrid = document.getElementById("additional-services-grid");
      if (addGrid) {
        additionalServices.forEach(function (svc) {
          var card = document.createElement("article");
          card.className = "pricing-card";

          if (svc.icon && ICONS[svc.icon]) {
            var iconEl = document.createElement("div");
            iconEl.className = "pricing-icon";
            iconEl.innerHTML = ICONS[svc.icon];
            card.appendChild(iconEl);
          }

          var name = document.createElement("h3");
          name.className = "pricing-name";
          name.textContent = svc.name;
          card.appendChild(name);

          var price = document.createElement("p");
          price.className = "pricing-price";
          price.textContent = svc.price;
          card.appendChild(price);

          var cta = document.createElement("a");
          cta.className = "btn btn-secondary";
          cta.href = "#contact";
          cta.textContent = "Book Now";
          card.appendChild(cta);

          addGrid.appendChild(card);
        });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  initLightbox();
  initContactForm();
  document.getElementById("footer-year").textContent = new Date().getFullYear();

  // data/nostr.json is optional for rendering: if it's missing or invalid we
  // fall back to the default sections so the site keeps working.
  var nostrConfigPromise = fetchJson("data/nostr.json").catch(function () {
    return null;
  });

  fetchJson("data/images.json")
    .then(function (data) {
      var posts = data.posts || [];
      return nostrConfigPromise.then(function (nostrConfig) {
        initCarousel(postsWithTag(posts, CAROUSEL_TAG));
        renderGalleries(posts, deriveSections(nostrConfig));
      });
    })
    .catch(function (err) {
      console.warn(err.message);
      initCarousel([]);
    });

  fetchJson("data/pricing.json")
    .then(renderPricing)
    .catch(function (err) {
      console.warn(err.message);
    });
})();
