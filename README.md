# Nova Framework

A basic, web proxy useing Scramjet and Ultravilot prioratizeing stability, embedability, utility, and functionality.

## Deploy

> [!IMPORTANT]
> Nova Sadley cannot run on static hosting sites

## Setup

```
git clone https://github.com/sriail/nova-proxy
cd nova-proxy
npm i
npm start
```
or use npm dev for a dev enviroment (optimal for building and testing components, but has limited functionality)

```
git clone https://github.com/sriail/nova-proxy
cd nova-proxy
npm i
npm dev
```
## Tech Stack

- Npm (Js build manager)
- Wisp.js (wisp server)
- Scramjet (experamental web proxy)
- Ultravilot (legacy web proxy)
- Epoxy (wss and ws transport)
- Fastify (http server)

## Site Support
- Google
- Wikipeda
- Reddit
- X (formerly twitter)
- Youtube
- TikTok
- Facebook 
- Crazygames
- Eaglercraft
- Twitch

And may more!
## System/ Varification Support 
- Recaptha†
- Hcaptha†
- Yandex Cloud
- Cloudflare (Turnstile, JS Challenges, Bot Management)
- Browser Verification
- Varfication cookies*

And more

*Not all varafication cookies will work or function properley and errors can occur.

†Recaptha and Hcaptha Supported on Scramjet proxy, However, Ultravilot may struggle, especialy with a heavley traficed wisp server.

## Planed Updates and Roadmap

- [x] Add Full Varifacation Support (Browser & Cloudflare verification)
- [ ] Add Wisp Server Rotation
- [ ] Add Personal Wisp Server/ Static Server System
- [ ] Update Favicon System
- [ ] Potentialy add Bare Server Support (Possibley)
- [ ] Add Autopilot Mode (audomatic Proxy swiching with a JS or JSON config)
- [ ] Add Varified Site Config (Possibley)
- [ ] Update UI
- [ ] Add Bookmarks
- [ ] Add subblt icons (audio playing, ect)
- [ ] Fully implament conplex error page
