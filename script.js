import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getDatabase, ref, onValue, remove, get, set } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js";
import { 
	getFirestore, doc, setDoc, getDocs, updateDoc, onSnapshot, collection, query, orderBy 
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const firebaseConfig = {
	apiKey: "AIzaSyCGKbae1WdYNc9IZwbjJ-wPdoyOVxNb5_k",
	authDomain: "als-run.firebaseapp.com",
	databaseURL: "https://als-run-default-rtdb.firebaseio.com",
	projectId: "als-run",
	storageBucket: "als-run.firebasestorage.app",
	messagingSenderId: "494931128698",
	appId: "1:494931128698:web:1b6d83b3b082b7f17fa6c3",
	measurementId: "G-WN4X8YRQVF"
};

const app = initializeApp(firebaseConfig);
const realtimeDatabase = getDatabase(app);
export const firestore = getFirestore(app);

const TOTAL_RUN_MILES = 50.0;
let runStartTime = null;
let runEndTime = null;
let runStatus = "not_started";
let timerInterval = null;
const isAdmin = new URLSearchParams(window.location.search).get("admin") === "secret123";

// Display waypoints container ONLY if admin
if (isAdmin) {
    const wptContainer = document.getElementById("waypoints-section");
    if (wptContainer) {
        wptContainer.style.display = "block";
    }
}

// Waypoint Map Markers State
let waypointsLayerGroup = L.layerGroup();
let showWaypointsOnMap = false;
let cachedWaypointsData = [];

// 1. Initialize Leaflet Map
const map = L.map('map').setView([43.0731, -89.4012], 12);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
	attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

waypointsLayerGroup.addTo(map);

const pathLine = L.polyline([], { color: '#FF4500', weight: 4, smoothFactor: 1.5 }).addTo(map);
let runnerMarker = null;

// Load GPX Route
async function loadGPXRoute(map) {
    try {
        const response = await fetch('./route.gpx');
        const gpxText = await response.text();
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(gpxText, "text/xml");
        const trackpoints = xmlDoc.querySelectorAll("trkpt");
        const routeCoords = [];

        trackpoints.forEach(pt => {
            const lat = parseFloat(pt.getAttribute("lat"));
            const lon = parseFloat(pt.getAttribute("lon"));
            if (!isNaN(lat) && !isNaN(lon)) routeCoords.push([lat, lon]);
        });

        const gpxPolyline = L.polyline(routeCoords, {
            color: '#0066cc', weight: 4, opacity: 0.6, lineJoin: 'round'
        }).addTo(map);

        map.fitBounds(gpxPolyline.getBounds());
    } catch (error) {
        console.error("Error loading GPX file:", error);
    }
}
loadGPXRoute(map);

// 2. Realtime Location Tracking
const locationRef = ref(realtimeDatabase, 'location');
onValue(locationRef, snapshot => {
	const data = snapshot.val();
	
	if (!data) {
		pathLine.setLatLngs([]);
		if (runnerMarker) {
			map.removeLayer(runnerMarker);
			runnerMarker = null;
		}
		document.getElementById('lat').innerText = "Waiting...";
		document.getElementById('lng').innerText = "Waiting...";
		return;
	}

	const pings = Object.values(data)
		.filter(ping => ping.lat && ping.lon)
		.sort((a, b) => a.tst - b.tst);

	const coordinates = pings.map(ping => [ping.lat, ping.lon]);

	if (coordinates.length > 0) {
		const latestCoord = coordinates[coordinates.length - 1];

		document.getElementById('lat').innerText = latestCoord[0].toFixed(5);
		document.getElementById('lng').innerText = latestCoord[1].toFixed(5);

		pathLine.setLatLngs(coordinates);

		if (!runnerMarker) {
			runnerMarker = L.marker(latestCoord).addTo(map);
		} else {
			runnerMarker.setLatLng(latestCoord);
		}
	}
});

function updateDistanceUI(distanceKm) {
	const distanceMiles = distanceKm * 0.621371;
	const distancePercent = Math.min(100, (distanceMiles / TOTAL_RUN_MILES) * 100);

	document.getElementById("distance-text").innerText = `${distanceMiles.toFixed(1)} / ${TOTAL_RUN_MILES} miles`;
	document.getElementById("distance-bar").style.width = `${distancePercent}%`;
}

// 3. Timer & Status UI Handling
function updateTimerDisplay() {
	if (!runStartTime) {
		document.getElementById("run-timer").innerText = "00:00:00";
		return;
	}

	const endTimeToUse = runEndTime ? new Date(runEndTime) : new Date();
	const diffMs = endTimeToUse - new Date(runStartTime);
	if (diffMs < 0) return;

	const hrs = Math.floor(diffMs / 3600000);
	const mins = Math.floor((diffMs % 3600000) / 60000);
	const secs = Math.floor((diffMs % 60000) / 1000);

	document.getElementById("run-timer").innerText = 
		`${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// 4. Render Waypoint Markers on Map
function renderWaypointsOnMap() {
	waypointsLayerGroup.clearLayers();
	if (!showWaypointsOnMap) return;

	cachedWaypointsData.forEach(wpt => {
		const isReached = wpt.reached === true;
		const color = isReached ? "#28a745" : "#0066cc";

		const marker = L.circleMarker([wpt.lat, wpt.lon], {
			radius: 7,
			fillColor: color,
			color: "#ffffff",
			weight: 2,
			opacity: 1,
			fillOpacity: 0.9
		});

		marker.bindTooltip(`<b>#${wpt.order}: ${wpt.name}</b><br>${(wpt.distanceFromStartKm * 0.621371).toFixed(1)} mi`, {
			permanent: true,
			direction: 'top',
			offset: [0, -8],
			className: 'wpt-map-label'
		});

		waypointsLayerGroup.addLayer(marker);
	});
}

// 5. Firestore Listeners
function initFirestoreListeners() {
	onSnapshot(doc(firestore, "progress", "current"), (snapshot) => {
		if (!snapshot.exists()) return;
		const data = snapshot.data();

		runStatus = data.status || "not_started";
		runStartTime = data.startTime || null;
		runEndTime = data.endTime || null;

		updateDistanceUI(data.totalDistanceCoveredKm || 0);

		if (timerInterval) clearInterval(timerInterval);

		if (runStatus === "in_progress") {
			document.getElementById("timer-status").innerText = "Run in progress";
			timerInterval = setInterval(updateTimerDisplay, 1000);
			updateTimerDisplay();
		} else if (runStatus === "completed") {
			document.getElementById("timer-status").innerText = "Run Complete! 🎉";
			updateTimerDisplay();
		} else {
			document.getElementById("run-timer").innerText = "00:00:00";
			document.getElementById("timer-status").innerText = "Not yet started";
		}
	});

	const waypointsQuery = query(collection(firestore, "waypoints"), orderBy("order", "asc"));
	onSnapshot(waypointsQuery, (snapshot) => {
		const waypointsList = document.getElementById("waypoints-list");
		waypointsList.innerHTML = "";

		cachedWaypointsData = snapshot.docs.map(docSnap => ({
			id: docSnap.id,
			...docSnap.data()
		}));

		cachedWaypointsData.forEach(wpt => {
			const isReached = wpt.reached === true;

			const card = document.createElement("div");
			card.className = `wpt-item ${isReached ? 'reached' : 'pending'}`;

			let content = `
				<div class="wpt-header">
					<span class="wpt-order">#${wpt.order}</span>
					<span class="wpt-name">${wpt.name}</span>
				</div>
				<div class="wpt-details">
					<span>${(wpt.distanceFromStartKm * 0.621371).toFixed(1)} mi</span>
					<span class="wpt-status">${isReached ? '✓ Completed' : 'Pending'}</span>
				</div>
			`;

			if (isAdmin) {
				if (!isReached) {
					content += `<button class="complete-btn" data-docid="${wpt.id}" data-order="${wpt.order}" data-name="${wpt.name}" data-dist="${wpt.distanceFromStartKm}">Mark Complete</button>`;
				} else {
					content += `<button class="unmark-btn" data-docid="${wpt.id}" data-order="${wpt.order}">Unmark Complete</button>`;
				}
			}

			card.innerHTML = content;
			waypointsList.appendChild(card);
		});

		if (isAdmin) {
			document.querySelectorAll(".complete-btn").forEach(btn => {
				btn.addEventListener("click", handleManualWaypointComplete);
			});
			document.querySelectorAll(".unmark-btn").forEach(btn => {
				btn.addEventListener("click", handleManualWaypointUnmark);
			});
		}

		renderWaypointsOnMap();
	});
}

// 6. Admin Actions: Mark / Unmark Waypoints (Without Affecting Distance)
async function handleManualWaypointComplete(e) {
	const docId = e.target.getAttribute("data-docid");
	const order = parseInt(e.target.getAttribute("data-order"));
	const name = e.target.getAttribute("data-name");
	const timestamp = new Date().toISOString();

	await updateDoc(doc(firestore, "waypoints", docId), {
		reached: true,
		reachedTimestamp: timestamp
	});

	await updateDoc(doc(firestore, "progress", "current"), {
		lastWaypointName: name,
		lastWaypointTime: timestamp,
		nextOrder: order + 1,
		updatedAt: timestamp
	});
}

async function handleManualWaypointUnmark(e) {
	const docId = e.target.getAttribute("data-docid");
	const order = parseInt(e.target.getAttribute("data-order"));

	await updateDoc(doc(firestore, "waypoints", docId), {
		reached: false,
		reachedTimestamp: null
	});

	await updateDoc(doc(firestore, "progress", "current"), {
		nextOrder: order,
		updatedAt: new Date().toISOString()
	});
}

// Start Run Admin Action (Clears history but preserves the latest location ping)
async function startRun() {
	if (!confirm("Are you ready to START the run? This will clear historical location pings while keeping the latest starting position.")) return;

	const startTime = new Date().toISOString();
	const locRef = ref(realtimeDatabase, 'location');

	// 1. Fetch current pings to preserve the latest starting point
	const snapshot = await get(locRef);
	let latestPing = null;

	if (snapshot.exists()) {
		const pings = Object.values(snapshot.val())
			.filter(ping => ping.lat && ping.lon)
			.sort((a, b) => a.tst - b.tst);

		if (pings.length > 0) {
			latestPing = pings[pings.length - 1];
		}
	}

	// 2. Clear location database history
	await remove(locRef);

	// 3. Re-insert only the latest ping so map renders starting location marker
	let startLoc = null;
	if (latestPing) {
		const newPingRef = ref(realtimeDatabase, `location/start_${Date.now()}`);
		await set(newPingRef, latestPing);
		startLoc = { lat: latestPing.lat, lon: latestPing.lon };
	}

	// 4. Set progress status to in_progress in Firestore
	await updateDoc(doc(firestore, "progress", "current"), {
		status: "in_progress",
		startTime: startTime,
		endTime: null,
		...(startLoc && { currentLocation: startLoc }),
		updatedAt: startTime
	});

	alert("Run started!");
}

// Reset Run Admin Action
async function resetRunProgress() {
    if (!confirm("Are you sure you want to RESET run progress? Status will set to Not Yet Started and location history cleared.")) return;

    // 1. Clear Realtime Database Location Pings
    await remove(ref(realtimeDatabase, 'location'));

    // 2. Reset Firestore Waypoints
    const waypointsSnap = await getDocs(collection(firestore, "waypoints"));
    for (const wptDoc of waypointsSnap.docs) {
        await updateDoc(wptDoc.ref, {
            reached: false,
            reachedTimestamp: null
        });
    }

    // 3. Reset Firestore Progress Document
    await setDoc(doc(firestore, "progress", "current"), {
        status: "not_started",
        lastWaypointName: "Start Line",
        lastWaypointTime: null,
        totalDistanceCoveredKm: 0,
        nextOrder: 1,
        startTime: null,
        endTime: null,
        currentLocation: null,
        updatedAt: new Date().toISOString()
    });

    alert("Run progress reset to Not Yet Started.");
}

// 7. Fetch Donation Goal Progress (Cloud Function Proxy)
async function fetchDonationProgress() {
	const functionUrl = "https://us-central1-als-run.cloudfunctions.net/getDonations";

	try {
		const res = await fetch(functionUrl);
		if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
		
		const data = await res.json();
		updateDonationUI(data.raised || 0, data.goal || 5000);
	} catch (err) {
		console.warn("Could not fetch donation progress from function:", err);
		updateDonationUI(0, 5000);
	}
}

function updateDonationUI(raised, goal) {
	const percent = Math.min(100, (raised / goal) * 100);
	document.getElementById("donation-text").innerText = `$${raised.toLocaleString()} / $${goal.toLocaleString()}`;
	document.getElementById("donation-bar").style.width = `${percent}%`;
}

// 8. Admin Control Panel Initialization
if (isAdmin) {
    const adminDiv = document.createElement("div");
    adminDiv.id = "admin-panel";
    adminDiv.style.cssText = "position:fixed; bottom:20px; right:20px; z-index:9999; background:#fff; padding:15px; border:2px solid red; border-radius:8px; box-shadow:0 4px 10px rgba(0,0,0,0.2); display:flex; flex-direction:column; gap:8px;";
    adminDiv.innerHTML = `
		<h4 style="margin:0; color:red;">Admin Mode</h4>
		<button id="start-btn" style="background:#28a745; color:white; padding:8px 12px; border:none; border-radius:4px; cursor:pointer; font-weight:bold;">🚀 Start Run</button>
		<button id="toggle-wpt-btn" style="background:#0066cc; color:white; padding:8px 12px; border:none; border-radius:4px; cursor:pointer;">📍 Toggle Map Waypoints</button>
		<button id="reset-btn" style="background:#dc3545; color:white; padding:8px 12px; border:none; border-radius:4px; cursor:pointer;">⚠️ Reset Run Progress</button>
	`;
    document.body.appendChild(adminDiv);

    document.getElementById("start-btn").addEventListener("click", startRun);
    document.getElementById("reset-btn").addEventListener("click", resetRunProgress);
    document.getElementById("toggle-wpt-btn").addEventListener("click", () => {
    	showWaypointsOnMap = !showWaypointsOnMap;
    	renderWaypointsOnMap();
    });
}

// Initialize Application
initFirestoreListeners();
fetchDonationProgress();
setInterval(fetchDonationProgress, 300000);