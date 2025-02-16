const express = require("express");
const axios = require("axios");
const ExcelJS = require("exceljs");
const path = require("path");
const dotenv = require("dotenv");
const winston = require("winston");
const fs = require("fs");

dotenv.config();
const app = express();
const port = 3000;

// Logger setup
const logger = winston.createLogger({
    level: "info",
    format: winston.format.json(),
    transports: [
        new winston.transports.File({ filename: "app.log" }),
        new winston.transports.Console({ format: winston.format.simple() }),
    ],
});

// Serve static files
app.use(express.static(path.join(__dirname)));

// Load speed limits data
const speedLimits = JSON.parse(fs.readFileSync(path.join(__dirname, "speed_limits.json"), "utf-8"));

// Function to fetch a route from OSRM
async function getRoute(locations) {
    try {
        const coordString = locations.join(";");
        console.log(`Fetching route for locations: ${coordString}`);

        const response = await axios.get(
            `http://router.project-osrm.org/route/v1/driving/${coordString}?overview=full&geometries=geojson`
        );

        if (!response.data || !response.data.routes || response.data.routes.length === 0) {
            throw new Error("Invalid response from OSRM.");
        }

        console.log("Route fetched successfully");
        return response.data.routes[0].geometry.coordinates;
    } catch (error) {
        console.error("OSRM request failed:", error.message);
        throw new Error("Could not get route data.");
    }
}

// Function to calculate Haversine distance (accurate distance between two points)
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 3958.8; // Earth radius in miles
    const toRad = (deg) => (deg * Math.PI) / 180;
    
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in miles
}

// Function to get speed limit based on state
async function getStateFromCoordinates(lat, lon) {
    try {
        const response = await axios.get("https://nominatim.openstreetmap.org/reverse", {
            params: { lat, lon, format: "json" }
        });
        return response.data.address.state || "Unknown";
    } catch (error) {
        console.error("Reverse geocoding failed:", error.message);
        return "Unknown";
    }
}

async function getSpeedLimit(lat, lon) {
    const state = await getStateFromCoordinates(lat, lon);
    return speedLimits[state] || 60; // Default speed limit if state not found
}

// Function to generate stops based on FMCSA rules and include user-provided stops
async function generateStops(route, userStops) {
    const stops = [];
    let milesTraveled = 0;
    let currentSpeed = 60;// Default speed
    let userIndex = 0;
    
    for (let i = 1; i < route.length; i++) {
        const [lon1, lat1] = route[i - 1];
        const [lon2, lat2] = route[i];
        
        const distance = haversineDistance(lat1, lon1, lat2, lon2);
        milesTraveled += distance;

        if (milesTraveled >= currentSpeed) {
            currentSpeed = await getSpeedLimit(lat1, lon1); // Update speed after 1 hour of travel
            stops.push({
                lat: lat1.toFixed(2),
                lon: lon1.toFixed(2),
                duration: "1:00",
                location: "Highway Stop",
                fuel: "Not Available",
            });
            milesTraveled = 0;
        }

        while (userIndex < userStops.length) {
            const [userLon, userLat] = userStops[userIndex];
            if (Math.abs(userLat - lat1) < 0.05 && Math.abs(userLon - lon1) < 0.05) {
                stops.push({
                    lat: userLat.toFixed(2),
                    lon: userLon.toFixed(2),
                    duration: "User Stop",
                    location: "User Provided Stop",
                    fuel: "Available",
                });
                userIndex++;
                milesTraveled = 0; // Reset after a user stop
            } else {
                break;
            }
        }
    }
    return stops;
}

// Function to create an Excel file dynamically
async function createExcel(stops) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Route Stops");

    sheet.columns = [
        { header: "Duration (HH:MM)", key: "duration", width: 15 },
        { header: "Latitude", key: "lat", width: 15 },
        { header: "Longitude", key: "lon", width: 15 },
        { header: "Location", key: "location", width: 20 },
        { header: "Fuel Available", key: "fuel", width: 15 },
    ];

    for (const stop of stops) {
        sheet.addRow(stop);
    }

    const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, "");
    const outputFile = path.join(__dirname, `route_stops_${timestamp}.xlsx`);
    await workbook.xlsx.writeFile(outputFile);
    
    return outputFile;
}

// Route to handle planning
app.get("/plan-route", async (req, res) => {
    const { coordinates } = req.query;
    if (!coordinates) {
        return res.status(400).send("Please provide coordinates.");
    }

    const coordList = coordinates
        .replace(/\|/g, ";")
        .replace(/,+/g, ",")
        .replace(/;$/, "")
        .split(";")
        .map(coord => coord.split(",").map(Number));

    if (coordList.length < 2) {
        return res.status(400).send("Need at least two locations.");
    }

    try {
        const route = await getRoute(coordList.map(coord => coord.join(",")));
        const stops = await generateStops(route, coordList);

        const outputFile = await createExcel(stops);
        
        res.download(outputFile, (err) => {
            if (err) {
                console.error("Error sending file:", err);
            } else {
                fs.unlink(outputFile, (err) => {
                    if (err) console.error("Error deleting file:", err);
                });
            }
        });
    } catch (error) {
        logger.error("Error planning route:", error);
        res.status(500).send("An error occurred while planning the route.");
    }
});

app.listen(port, () => {
    logger.info(`Server running on http://localhost:${port}`);
});
