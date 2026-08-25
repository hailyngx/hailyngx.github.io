---
title: "I built my own server"
description: "A PC that stays on, a 7B on the GPU I already had, and a one-page resume that never has to leave the house. Fun, on purpose, because nothing here has to talk to a camera."
pubDate: 2026-08-23
tags:
  - notes
---

The box is on. I paste a job description, wait about a minute, and a one-page PDF comes back that still looks like my resume. Phone can drop a file on it. The `.tex` stays in the house. That is the whole product. Everything else was me refusing to turn this PC into a weekend of virtualization.

At work I already boot VMs. They encode images and stream that data into simulation, and the GPU work has to stay compatible with a real camera system — live, low-latency, the car is allowed to be picky. That is a good job. It is also a burden. Doing this as a fun project has been more rewarding, and more enjoyable, than the size of the machine would suggest, mostly because that burden is gone. The 5060 Ti does not have to speak to a camera. If a 7B fits and a PDF comes back, I am done.

This is my first low-budget PC. I have been very excited to have a server on top of it — same box, not a second machine I put in the closet. Ryzen 5 3500X, one stick of 16 GB, a 512 GB SSD, an RTX 5060 Ti with 8 GB, Wi-Fi. Windows stays, because this is still the computer I use for everything else. Dual-boot would mean the server dies every time I sit down to work. Sleep is off. A machine that naps is a laptop.

The obvious homelab move is pass the GPU into Linux and feel serious. This board has no iGPU. Passthrough means a headless daily driver. I like having a monitor. So the split is ugly and correct: Ollama runs on Windows, where the 5060 Ti already works. A tiny Ubuntu VM (Multipass, Hyper-V, 2 vCPUs, 2 GB) serves the page, compiles LaTeX, holds files. They talk over the host-only address. Ollama is not on `0.0.0.0`. The rest of the house does not need a raw model port.

[![Desktop, phone, and the box: files and a JD in, Qwen on the GPU, Ubuntu VM, resume on the server](/images/homelab-sketch.jpeg)](/images/homelab-sketch.jpeg)

I picked Qwen 2.5 7B because it fits. 3B was cheaper and dumber. 14B would have been a swap-file personality test. I already have ChatGPT. I do not have an API key I want to meter per JD, and I do not want the master resume in a prompt that leaves by default. Local 7B is worse at prose. It is better at "this file did not become someone else's training set today."

The first version asked the model to rewrite the whole `.tex`. I got empty PDFs and a very confident preamble. A 7B is a wording engine, not a typesetter. Now I keep the Jake template, rewrite bullets in chunks, sort the tools in the role line by hand so it does not invent a new job, and fit one page by clipping — not by crushing `\vspace` until Education sits on top of Experience. If a rewrite drops too many of the original nouns, I throw it out. I'd rather a slightly generic bullet than "Waymo" appearing in a job that was not Waymo.

I would not ship off one happy PDF. I scraped live jobs off Waymo's careers page and used those as the benchmark: simulation infrastructure, ML/eval data, simulator orchestration, SRE.

The loop was the same four listings, every round. Generate. Read it like a recruiter — phone screen, or bounce for lying. Then score the boring checks: did the JD's languages and nouns actually show up, are the systems I built still in the bullets, did "Waymo" leak into a job that was not Waymo, did LaTeX eat a backslash and print garbage, did we glue on a tool the posting never asked for. Change one thing in the splice. Run the four again.

That is how asking the model for a whole `.tex` died. That is how role titles stopped being the model's to invent. That is how one page became "cut a bullet" instead of shrinking the template until Education sat on Experience. I stopped when the simulation-infra and ML/eval versions were something I'd send. Orchestration stayed a stretch. SRE stayed weak if the posting wanted on-call I do not have. A script can count keywords. I still had to look at the PDF.

Proxmox, Ethernet, a second PC, Kubernetes — later, if I ever have a second product. I cannot un-buy a mini PC I put in the closet. Wi-Fi is fine. A JD and a PDF do not care that the NIC is a Realtek.

The page is `http://haily-homelab:8080` on this machine. Phone uses the LAN IP until I bother renaming `DESKTOP-D29G1M0`. I pointed a friendly name at localhost and called it done. Proof the file path works: I recorded the screen on my phone, uploaded it, downloaded it here. Camera-roll `.jpeg` failed first because Linux treated `C:\fakepath\image.jpeg` as one illegal name. That is a phone bug, not a product.

If the page still loads with the monitor unplugged, it's a server. If the PDF still looks like me, it's the product. I would not call this infra in the sense I mean at work. I would call it the smallest thing that made the loop real.
