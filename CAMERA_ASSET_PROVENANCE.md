# Камеры — демонстрационные изображения

Созданы встроенным image_gen 16 ноября 2026 для локального mock UI. Это отдельные вымышленные статичные виды; они не являются синхронизированными кадрами одной поездки, реальными камерами G07 или измерениями расстояний. Автомобиль не подключён. Полноценная геометрия камер и калибровка не заявляются.

| Файл | Происхождение |
|---|---|
| src/assets/camera-front-demo.png | exec-cfcf83f4-5998-4310-be03-ee57a244b65b.png |
| src/assets/camera-left-demo.png | exec-3dab0e02-9f20-4760-b80c-b8e0b8beaace.png, уточнение исходного exec-1be1bd90-a475-46f1-864c-cdd7e9067841.png |
| src/assets/camera-right-demo.png | exec-3c6c1f1b-7a38-4225-91ee-d68d580c35a0.png |

## Точные промпты

### Спереди

Use case: photorealistic-natural. Asset type: fictional static image for a demonstration of a car off-road camera UI. Landscape 16:9. Natural realistic camera image, broad field of view with mild optical distortion, diffuse overcast daylight, rough rocky mountain dirt track with ruts, scattered small stones, low green shrubs. Fine realistic textures, neutral color balance. No interface, no text, no logos, no watermark, no parking guidelines, no people or other vehicles, no digital markers. This is an illustrative fictional camera frame, not a real live feed. Camera viewpoint: mounted at the center of the front grille of a large SUV, about 70 cm above the road, looking straight ahead slightly down. The immediate rocky track fills lower two thirds; the path continues between grassy slopes toward distant wooded hills. A small rock step and a shallow rut directly ahead are clearly visible. Keep front bumper and vehicle out of frame. Calm practical visibility, not cinematic dramatic scenery.

### Слева

Use case: photorealistic-natural. Asset type: fictional static image for a demonstration of a car off-road camera UI. Landscape 16:9. Natural realistic camera image, broad field of view with mild optical distortion, diffuse overcast daylight, rough rocky mountain dirt track with ruts, scattered small stones, low green shrubs. Fine realistic textures, neutral color balance. No interface, no text, no logos, no watermark, no parking guidelines, no people or other vehicles, no digital markers. This is an illustrative fictional camera frame, not a real live feed. Camera viewpoint: left exterior mirror looking diagonally downward along the left flank of a graphite grey SUV toward its left front wheel and the ground beside it. A narrow strip of graphite vehicle body occupies the RIGHT edge, with part of the near wheel visible at lower right; the rocky track and shallow left rut fill the rest of the frame. Show nearby stones and a grassy bank outside the left side. Low-speed off-road surround-view style, practical and realistic, not a third-person car photo.

### Справа

Use case: photorealistic-natural. Asset type: fictional static image for a demonstration of a car off-road camera UI. Landscape 16:9. Natural realistic camera image, broad field of view with mild optical distortion, diffuse overcast daylight, rough rocky mountain dirt track with ruts, scattered small stones, low green shrubs. Fine realistic textures, neutral color balance. No interface, no text, no logos, no watermark, no parking guidelines, no people or other vehicles, no digital markers. This is an illustrative fictional camera frame, not a real live feed. Camera viewpoint: right exterior mirror looking diagonally downward along the right flank of a graphite grey SUV toward its right front wheel and the ground beside it. A narrow strip of graphite vehicle body occupies the LEFT edge, with part of the near wheel visible at lower left; the rough gravel track fills the rest of the frame. Show a low pale stone ridge and green shrubs to the right side. Low-speed off-road surround-view style, practical and realistic, not a third-person car photo.

### Уточнение левого изображения

Use case: precise-object-edit. Edit the supplied fictional off-road camera demonstration image. Remove the entire rear-view mirror frame, mirror glass boundary and the curved black bezel from the image. Fill those areas continuously with the same rocky ground and green shrubs. This must look like direct footage from a small exterior side camera on the left flank of the vehicle, NOT a reflection in a mirror and not a framed image. Keep the graphite SUV body and visible wheel on the right edge, preserve overall rocky road, lighting, camera direction and landscape composition. Full bleed 16:9 landscape camera frame. No UI, text, labels, logo, watermark, guidelines, or new objects.

