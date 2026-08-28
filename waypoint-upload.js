import { getApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getFirestore, doc, setDoc, collection, getDocs, deleteDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const CHECKPOINT_INTERVAL_KM = 2.0;

async function seedGPXToFirestore() {
    const app = getApp();
    const firestore = getFirestore(app);

    const response = await fetch('./route.gpx');
    const xml = new DOMParser().parseFromString(await response.text(), 'text/xml');

    // 1. Clear out any stale/old waypoints if total count changed
    const existingWpts = await getDocs(collection(firestore, "waypoints"));
    for (const snapDoc of existingWpts.docs) {
        await deleteDoc(snapDoc.ref);
    }

    // 2. Parse trackpoints & compute cumulative distance
    const trackpoints = xml.querySelectorAll('trkpt');
    const routeTrack = [];
    let totalDistMeters = 0;

    trackpoints.forEach((node, idx) => {
        const lat = parseFloat(node.getAttribute('lat'));
        const lon = parseFloat(node.getAttribute('lon'));

        if (idx > 0) {
            const prev = routeTrack[idx - 1];
            totalDistMeters += getDistanceMeters(prev.lat, prev.lon, lat, lon);
        }

        routeTrack.push({
            lat,
            lon,
            accumulatedDistanceKm: totalDistMeters / 1000
        });
    });

    // 3. Sample trackpoints to create zero-padded sequential checkpoints
    let order = 1;
    let nextTargetKm = 0;

    for (const pt of routeTrack) {
        if (pt.accumulatedDistanceKm >= nextTargetKm) {
            const padOrder = String(order).padStart(2, '0'); // Formats 1 -> "01", 2 -> "02"
            const checkpointName = nextTargetKm === 0 
                ? "Start Line" 
                : `${nextTargetKm.toFixed(1)} km Checkpoint`;

            await setDoc(doc(firestore, "waypoints", `wpt_${padOrder}`), {
                name: checkpointName,
                lat: pt.lat,
                lon: pt.lon,
                distanceFromStartKm: parseFloat(pt.accumulatedDistanceKm.toFixed(2)),
                order: order,
                orderPadded: padOrder,
                reached: nextTargetKm === 0,
                reachedTimestamp: nextTargetKm === 0 ? new Date().toISOString() : null
            });

            order++;
            nextTargetKm += CHECKPOINT_INTERVAL_KM;
        }
    }

    // 4. Always append Finish Line
    const lastPt = routeTrack[routeTrack.length - 1];
    if (lastPt.accumulatedDistanceKm > (nextTargetKm - CHECKPOINT_INTERVAL_KM)) {
        const padOrder = String(order).padStart(2, '0');
        await setDoc(doc(firestore, "waypoints", `wpt_${padOrder}`), {
            name: "Finish Line",
            lat: lastPt.lat,
            lon: lastPt.lon,
            distanceFromStartKm: parseFloat(lastPt.accumulatedDistanceKm.toFixed(2)),
            order: order,
            orderPadded: padOrder,
            reached: false,
            reachedTimestamp: null
        });
    }

    // 5. Reset progress tracking status
    await setDoc(doc(firestore, "progress", "current"), {
        lastWaypointName: "Start Line",
        lastWaypointTime: new Date().toISOString(),
        totalDistanceCoveredKm: 0,
        nextOrder: 2,
        currentLocation: null,
        updatedAt: new Date().toISOString()
    });

    console.log(`Firestore successfully seeded/reset with ${order} checkpoints!`);
}

function getDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

window.seedGPXToFirestore = seedGPXToFirestore;