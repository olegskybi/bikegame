# Bike Game Assets

Place replacement images in this folder with exactly these names:

| File | Purpose | Recommended size |
| --- | --- | --- |
| `road_bg.png` | scrolling road/background | 900x1600 or 1080x1920 |
| `courier/1.png` ... `courier/8.png` | preferred frame-by-frame courier animation | 512x512, transparent, numbered in playback order |
| `courier.gif` | optional animated courier with pedaling | same proportions as `courier.png`, transparent if possible |
| `courier.png` | player/courier | 256x256 or 512x512, transparent |
| `obstacle.png` | obstacle variant 1 | 256x256, transparent |
| `obstacle_1.png` | obstacle variant 2 | 256x256, transparent |
| `product_1.png` | product variant 1 | 192x192 or 256x256, transparent |
| `product_2.png` | product variant 2 | 192x192 or 256x256, transparent |
| `product_3.png` | product variant 3 | 192x192 or 256x256, transparent |
| `product_4.png` | product variant 4 | 192x192 or 256x256, transparent |
| `product_5.png` | product variant 5 | 192x192 or 256x256, transparent |
| `life.png` | extra life bonus | 192x192, transparent |
| `bonus.png` | bonus product | 192x192, transparent |
| `coin.png` | coin | 128x128 or 192x192, transparent |

The HTML expects this structure:

```text
game.html
assets/
  road_bg.png
  courier/
    1.png
    2.png
    3.png
    4.png
    5.png
    6.png
    7.png
    8.png
  courier.gif        (optional)
  courier.png
  obstacle.png
  obstacle_1.png
  product_1.png
  product_2.png
  product_3.png
  product_4.png
  product_5.png
  life.png
  bonus.png
  coin.png
```

If an image is missing, the game will still run and draw a simple fallback shape for that object.
