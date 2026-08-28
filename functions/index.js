const { onValueCreated } = require("firebase-functions/v2/database");
const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

if (admin.apps.length === 0) {
    admin.initializeApp();
}

const firestore = admin.firestore();

// Haversine formula to compute distance in meters between 2 coordinates
function getDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 1. Triggers whenever OwnTracks adds a new position to Realtime Database /location/{pushId}
exports.onLocationUpdate = onValueCreated("/location/{pushId}", async (event) => {
    const ping = event.data.val();
    if (!ping || !ping.lat || !ping.lon) return null;

    const liveLat = ping.lat;
    const liveLon = ping.lon;
    const timestamp = ping.tst ? new Date(ping.tst * 1000).toISOString() : new Date().toISOString();

    // Fetch current progress state
    const progressRef = firestore.collection("progress").doc("current");
    const progressSnap = await progressRef.get();
    if (!progressSnap.exists) return null;

    const progressData = progressSnap.data();

    // ALWAYS update currentLocation in Firestore regardless of status
    if (progressData.status !== "in_progress") {
        await progressRef.update({
            currentLocation: { lat: liveLat, lon: liveLon },
            updatedAt: new Date().toISOString()
        });
        return null;
    }

    const nextOrder = progressData.nextOrder || 2;
    const currentTotalKm = progressData.totalDistanceCoveredKm || 0;
    const lastLocation = progressData.currentLocation;

    // Calculate incremental distance moved since last ping (in km)
    let addedKm = 0;
    if (lastLocation && lastLocation.lat && lastLocation.lon) {
        const metersMoved = getDistanceMeters(lastLocation.lat, lastLocation.lon, liveLat, liveLon);
        if (metersMoved >= 5) { // Filter small GPS jitter
            addedKm = metersMoved / 1000;
        }
    }

    const newTotalDistanceKm = currentTotalKm + addedKm;

    // Check target waypoint
    const waypointsRef = firestore.collection("waypoints");
    const nextWptQuery = await waypointsRef.where("order", "==", nextOrder).get();
    
    let isCheckpointReached = false;
    let nextWpt = null;
    let nextWptDoc = null;

    if (!nextWptQuery.empty) {
        nextWptDoc = nextWptQuery.docs[0];
        nextWpt = nextWptDoc.data();
        const distMeters = getDistanceMeters(liveLat, liveLon, nextWpt.lat, nextWpt.lon);

        if (distMeters <= 50) { // 50m radius
            isCheckpointReached = true;
        }
    }

    if (isCheckpointReached && nextWptDoc) {
        await nextWptDoc.ref.update({
            reached: true,
            reachedTimestamp: timestamp
        });

        // Check if there are any remaining waypoints after this one
        const futureWptQuery = await waypointsRef.where("order", "==", nextOrder + 1).get();
        const isLastWaypoint = futureWptQuery.empty;

        const updatePayload = {
            lastWaypointName: nextWpt.name,
            lastWaypointTime: timestamp,
            totalDistanceCoveredKm: newTotalDistanceKm, // Pure GPS distance
            nextOrder: nextOrder + 1,
            currentLocation: { lat: liveLat, lon: liveLon },
            updatedAt: new Date().toISOString()
        };

        if (isLastWaypoint) {
            updatePayload.status = "completed";
            updatePayload.endTime = timestamp;
            logger.info(`Run Completed! Final checkpoint: ${nextWpt.name}`);
        } else {
            logger.info(`Checkpoint reached: ${nextWpt.name}`);
        }

        await progressRef.update(updatePayload);
    } else {
        await progressRef.update({
            totalDistanceCoveredKm: newTotalDistanceKm,
            currentLocation: { lat: liveLat, lon: liveLon },
            updatedAt: new Date().toISOString()
        });
    }

    return null;
});

// 2. HTTPS Proxy Function for Convio Donation Progress
exports.getDonations = onRequest({ cors: true }, async (req, res) => {
    try {
        const convioUrl = "https://secure2.convio.net/alsa/site/TR?px=9379266&fr_id=17505&pg=personal";
        const response = await fetch(convioUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
        });
        
        const html = await response.text();

        const raisedMatch = html.match(/(?:amount-raised|donated-amount|progress-bar-amount-raised)[^>]*>\s*\$([\d,]+(?:\.\d{2})?)/i) ||
                            html.match(/\$([\d,]+(?:\.\d{2})?)\s*(?:raised|of)/i);
                            
        const goalMatch = html.match(/(?:goal-amount|progress-bar-goal)[^>]*>\s*\$([\d,]+(?:\.\d{2})?)/i) ||
                          html.match(/of\s*\$([\d,]+(?:\.\d{2})?)/i);

        const raised = raisedMatch ? parseFloat(raisedMatch[1].replace(/,/g, '')) : 0;
        const goal = goalMatch ? parseFloat(goalMatch[1].replace(/,/g, '')) : 5000;

        res.json({ raised, goal });
    } catch (err) {
        logger.error("Error fetching donation page:", err);
        res.status(500).json({ raised: 0, goal: 5000, error: err.message });
    }
});