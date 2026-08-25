---
title: "I built my own server"
description: "Paste a job description, get a one-page resume PDF back, from a PC that stays on. Why I kept Windows, left the GPU on the host, and ran a 7B instead of buying a rack."
pubDate: 2026-08-23
tags:
  - notes
---

I spent a while working through "build a server" as a product problem — the kind of sentence that sounds like a rack until you write down what you actually want the box to do.

This is the design I landed on. I'm writing it down as notes I'd actually share: what the product is, which constraints were non-negotiable, and why I would not pass the GPU into a VM, stand up Kubernetes, or dual-boot this PC into a "real" Linux host.

A lot of the instinct is the same one I use at work: lock the product, name the bottleneck, add a box only when it attacks that bottleneck. The rest is furniture.

At work I already boot VMs. They exist so we can encode images and stream that data into simulation. The GPU work there has to stay compatible with a real camera system — live, low-latency, the car is allowed to be picky. That is the job, and it is a good job, and it is also a burden. Doing this box as a fun project has been more rewarding, and more enjoyable, than the size of the machine would suggest. Mostly because that burden is gone. The 5060 Ti does not have to speak to a camera. If a 7B fits and a PDF comes back, I am done. Compatibility with a real-world camera system is a different sport, and I am allowed to sit this one out.

The product, for me, is not "a homelab." It is: paste a job description, get a one-page tailored resume PDF back, from a machine that stays on in the other room. Files can ride along. The model runs here. The `.tex` never has to leave the house.

Same shape as the first GPU boxes people actually used in 2011: send work in, get a result out. Not a file locker with RGB.

---

## What I would and wouldn't build

I'd start by locking the product. Otherwise I accidentally design a NAS, a cluster, and a second career in cooling.

I'd include:

- A page I can open from this PC and from my phone on the same Wi-Fi
- A LaTeX resume that lives on the box
- Paste a JD → rewrite wording (does not invent jobs) → PDF
- Upload / download a file when I need to move something off a laptop
- A local model on the GPU that already sits in this machine

I'd leave out, unless I really wanted them: a second machine, extra RAM, Ethernet, GPU passthrough, Docker-for-its-own-sake, and anything with the word orchestration.

A few product questions hide most of the difficulty:

Is the PC still a daily driver? If I wipe Windows, I don't have a workstation. If I dual-boot, the server dies every time I boot into work. The interesting product is Windows stays, and something on it still answers at 2am.

Is the GPU for me or for a VM? This board has one GPU and no iGPU. Pass it through and the host goes headless. I like having a monitor. The model stays on Windows, where the 5060 Ti already works.

Is the model the product or the resume? If I ask a 7B to rewrite the whole `.tex`, I get an empty PDF and a very confident preamble. The interesting product is splice: keep the Jake template, rewrite bullets, clip to one page. The model is a wording engine, not a typesetter.

Non-negotiables I'd write on the board:

- Don't buy hardware. This PC is the lab.
- Don't take the only GPU away from Windows.
- Don't put the resume on someone else's GPU because I was too proud to run a small model.
- A server that sleeps is a laptop. Sleep stays off.
- One page. If it doesn't fit, cut. Don't crush the template until Education sits on top of Experience.

### Why "just use ChatGPT" is a different product

I already have ChatGPT. I do not have an API key I want to meter per job description, and I do not want the master `.tex` in a prompt that leaves the house by default.

Local 7B is worse at prose. It is better at "this file never became someone else's training set today." That's the trade. I would not pretend Qwen 2.5 7B is a staff writer. I would pretend I can constrain it until the output is usable.

---

## The one number

I wouldn't invent a rack. I'd name the bottleneck.

This box: Ryzen 5 3500X, one stick of 16 GB, a 512 GB SSD, an RTX 5060 Ti with 8 GB, Wi-Fi. The GPU is the only accelerator. The RAM is already doing Windows plus a VM. The disk is not a NAS.

The hard part is not "can I run Kubernetes." It's:

- 8 GB of VRAM, so the model has to fit with headroom
- no iGPU, so passthrough is a lifestyle choice I refuse
- 16 GB of system RAM, so the VM stays small
- a resume that must still be a Jake-template one-pager after the model has opinions

Those four are the scale pass. I do not add Proxmox, a second NIC, or GPU passthrough because a blog said that's what a homelab is. I add a box when it attacks one of those — or when I actually buy another machine, which I said I wouldn't.

---

## The shape that is the product

```
phone / laptop  -->  this PC (Windows + GPU)  -->  Ubuntu VM
                         Ollama on the host         nginx → the app
                                                    (files + LaTeX)
```

HTTP is fine. The page is the product. Almost every action is upload, paste, download.

Windows is the host because that's the computer I already sit at. Hyper-V is the hypervisor because it's already in Windows 11 Pro. Multipass is how I get one Ubuntu VM without turning this into a virtualization hobby. The guest is tiny on purpose: 2 vCPUs, 2 GB, 16 GB disk. It serves the site. It compiles LaTeX. It does not run the model.

Ollama listens on the Hyper-V host-only address, not on every interface in the house. The VM can reach it. The rest of the LAN does not need a raw model port. Binding that to `0.0.0.0` would be a bigger surface for a smaller gain. I would not.

Port 8080 on Windows forwards to port 80 in the VM. nginx in front of a single Python process. Max upload around 80 MB because I wanted "move a file," not "replace Drive."

That is the whole lab for now.

### Why the app is in a VM if the GPU is on Windows

Isolation, not fashion.

The guest is the thing I am willing to break: packages, nginx, systemd, a TeX live install. Windows stays the thing I log into for everything else. If I run the whole app on Windows I get a faster path and a messier host. If I run the model in the VM I get a correct-looking diagram and no display.

Split at the real boundary: GPU stays with Windows, POSIX stays with Ubuntu. They talk over a host-only IP. Boring on purpose.

---

## Tradeoffs I actually made

This is the part I wish someone had written for me. Same order as the sketch. I'll say when a choice is the product and when it is just refusing a template.

### Stay on Windows vs "real" Linux host

Product. This machine is a workstation. A server that requires me to stop using my computer is a weekend project, not a server.

Cost: Hyper-V, a vSwitch, and the eternal Windows-ism of "did I actually disable sleep." Benefit: the box is useful on Tuesday.

### Multipass vs Proxmox vs a second PC

Refusing a template. Proxmox is a good hypervisor. It is not free if the price is this Windows install. A second PC is a purchase. Multipass is one Ubuntu VM with a name, `homelab`, and a shell command I can remember.

I can graduate later. I cannot un-buy a mini PC I put in the closet and forgot.

### Local 7B vs a hosted API

Product. The resume is the sensitive object. The JD can be public. The combination is not something I want in a default cloud log.

Cost: smaller model, more guardrails, slower than a frontier API. Benefit: the loop is mine. I picked Qwen 2.5 7B because it fits 8 GB. 3B was cheaper and dumber. 14B would be a swap-file personality test.

### Splice bullets vs "rewrite this `.tex`"

Product, after I watched the other path produce empty PDFs.

A 7B will happily emit a document that looks like LaTeX in the same way a calendar design that stores ten years of Tuesdays looks like a database. The template is the invariant. I keep the original file, rewrite `\resumeItem` bodies in chunks, keep role titles mechanical (sort the tools, don't let the model invent a new job), and fit the page by clipping, not by `\vspace` terrorism.

If a rewrite doesn't keep enough of the original nouns, I don't take it. I'd rather a slightly generic bullet than "Waymo" appearing in a job that was not Waymo.

### Wi-Fi vs Ethernet

Not the bottleneck. A JD and a PDF do not care that this NIC is a Realtek on a laptop-grade link. Ethernet is a later box, if the house wants it. I would not delay the product for a cable.

### One VM vs a cluster

The scale pass I am not taking. One app, one process, one guest. I add a second VM when I have a second product, not when I want the diagram to look like work.

### Hostname vs renaming the PC

Vanity, with a limit. This PC is still `DESKTOP-D29G1M0`. I pointed `haily-homelab` at localhost so I can type something human on this machine. Phone `.local` wants a real rename and a reboot I have not done yet. Until then the phone uses the LAN IP. I would not pretend mDNS is a personality.

---

## What I actually run

Sleep off. Hyper-V on. One Multipass VM. nginx. a small app. Ollama on the host with a 7B. A desktop note with the URLs so I don't have to remember 8080.

On this PC: `http://haily-homelab:8080`. On a phone, same Wi-Fi, the current LAN IP until I bother renaming the machine.

If that page still loads with the monitor unplugged, it's a server. If a JD comes back as a one-page PDF that still looks like my resume, it's the product.

I would not call this infra in the sense I mean at work. I would call it the smallest thing that made the loop real. The theoretically best homelab can wait. The JD does not.
