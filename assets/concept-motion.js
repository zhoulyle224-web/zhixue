(() => {
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const reveals = [...document.querySelectorAll(".reveal")];

  if (reduceMotion || !("IntersectionObserver" in window)) {
    reveals.forEach((element) => element.classList.add("is-visible"));
  } else {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px" });
    reveals.forEach((element, index) => {
      element.style.transitionDelay = `${Math.min(index % 5, 4) * 55}ms`;
      observer.observe(element);
    });

    // Keep content available to full-page captures and unusual embedded browsers
    // that do not reliably emit intersection events for off-screen elements.
    window.setTimeout(() => {
      reveals.forEach((element) => element.classList.add("is-visible"));
    }, 900);
  }

  const parallax = document.querySelector("[data-parallax]");
  if (parallax && !reduceMotion) {
    const range = Number(parallax.dataset.parallax || 8);
    parallax.addEventListener("pointermove", (event) => {
      const box = parallax.getBoundingClientRect();
      const x = ((event.clientX - box.left) / box.width - 0.5) * range;
      const y = ((event.clientY - box.top) / box.height - 0.5) * range;
      parallax.style.setProperty("--parallax-x", `${x}px`);
      parallax.style.setProperty("--parallax-y", `${y}px`);
      const image = parallax.querySelector("img");
      if (image) image.style.translate = `${x}px ${y}px`;
    });
    parallax.addEventListener("pointerleave", () => {
      const image = parallax.querySelector("img");
      if (image) image.style.translate = "0 0";
    });
  }

  const preview = document.querySelector(".preview-grid");
  const previewButtons = [...document.querySelectorAll(".preview-arrows button")];
  previewButtons.forEach((button, index) => button.addEventListener("click", () => {
    if (!preview) return;
    preview.scrollBy({ left: index ? 320 : -320, behavior: reduceMotion ? "auto" : "smooth" });
  }));
})();
