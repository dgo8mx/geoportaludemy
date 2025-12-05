const supabaseUrl = 'url_proyecto';
const supabaseKey = 'api_key';

const layersConfig = {
    'barrios': { name: 'Barrios', color: '#8b5cf6', type: 'polygon', active: false },
    'agua_potable': { name: 'Agua Potable', color: '#06b6d4', type: 'polygon', active: false },
    'alcantarillado2': { name: 'Alcantarillado', color: '#84cc16', type: 'line', active: false },
    'bomberos_wgs84': { name: 'Bomberos', color: '#ef4444', type: 'point', active: true },
    'policia_wgs84': { name: 'Policía', color: '#3b82f6', type: 'point', active: true },
    'salud_wgs84': { name: 'Salud', color: '#10b981', type: 'point', active: true },
    'reportes': { name: 'Reportes', color: '#f59e0b', type: 'point', active: true, isRPC: true }
};

let map, layerGroups = {}, barriosIndex = [], currentBasemap = 'osm';
let reportLocation = null, reportMarker = null, mapPickingMode = false;

function init() {
    map = L.map('map', {
        center: [-4.0, -79.2],
        zoom: 13,
        zoomControl: false
    });

    const basemaps = {
        'osm': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { 
            attribution: '© OpenStreetMap contributors' 
        }),
        'esri': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { 
            attribution: '© Esri, Maxar, Earthstar Geographics' 
        }),
        'carto': L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { 
            attribution: '© OpenStreetMap © CartoDB' 
        }),
        'streets': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { 
            attribution: '© Esri, HERE, Garmin' 
        })
    };

    basemaps[currentBasemap].addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    map.on('click', (e) => {
        if (mapPickingMode) {
            setReportLocationFromMap(e.latlng);
        } else {
            calcDistances(e.latlng);
        }
    });

    buildBasemapUI(basemaps);
    buildLayersUI();
    loadDefaultLayers();
    preloadBarrios();
    setupEventListeners();

    setStatus('success', 'Geoportal cargado correctamente');
}

function setupEventListeners() {
    document.getElementById('search-input').addEventListener('input', onSearch);
    document.getElementById('get-current-location').addEventListener('click', getCurrentLocationForReport);
    document.getElementById('pick-on-map').addEventListener('click', startMapPicking);
    document.getElementById('set-manual-coords').addEventListener('click', setManualCoords);
    document.getElementById('report-send').addEventListener('click', sendReport);
}

function buildBasemapUI(basemaps) {
    const container = document.getElementById('basemaps');
    const basemapData = [
        { id: 'osm', name: 'OpenStreetMap', icon: 'fas fa-map', layer: basemaps.osm },
        { id: 'esri', name: 'Satélite', icon: 'fas fa-satellite', layer: basemaps.esri },
        { id: 'carto', name: 'Claro', icon: 'fas fa-map-marked', layer: basemaps.carto },
        { id: 'streets', name: 'Calles', icon: 'fas fa-road', layer: basemaps.streets }
    ];

    basemapData.forEach(bm => {
        const button = document.createElement('button');
        button.className = `basemap-btn ${bm.id === currentBasemap ? 'active' : ''}`;
        button.innerHTML = `<i class="${bm.icon}"></i><span>${bm.name}</span>`;
        button.addEventListener('click', () => changeBasemap(bm.id, bm.layer, basemaps));
        container.appendChild(button);
    });
}

function changeBasemap(id, layer, basemaps) {
    if (id === currentBasemap) return;

    map.removeLayer(basemaps[currentBasemap]);
    layer.addTo(map);
    currentBasemap = id;

    document.querySelectorAll('.basemap-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelector(`.basemap-btn:nth-child(${Object.keys(basemaps).indexOf(id) + 1})`).classList.add('active');

    setStatus('info', `Cambiado a: ${document.querySelector(`.basemap-btn:nth-child(${Object.keys(basemaps).indexOf(id) + 1}) span`).textContent}`);
}

function buildLayersUI() {
    const container = document.getElementById('layers');
    Object.entries(layersConfig).forEach(([key, cfg]) => {
        const item = document.createElement('div');
        item.className = 'layer-item';
        item.innerHTML = `
            <div class="layer-left">
                <span class="layer-badge" style="background-color: ${cfg.color};"></span>
                <span class="layer-label">${cfg.name}</span>
            </div>
            <label class="layer-switch">
                <input type="checkbox" ${cfg.active ? 'checked' : ''}>
                <span class="layer-slider"></span>
            </label>
        `;
        
        const checkbox = item.querySelector('input');
        checkbox.addEventListener('change', (e) => toggleLayer(key, e.target.checked));
        container.appendChild(item);
    });
}

async function loadDefaultLayers() {
    for (const [key, cfg] of Object.entries(layersConfig)) {
        if (cfg.active) {
            await loadLayer(key);
        }
    }
}

async function toggleLayer(key, visible) {
    if (visible) {
        await loadLayer(key);
    } else {
        if (layerGroups[key]) {
            map.removeLayer(layerGroups[key]);
            delete layerGroups[key];
        }
    }
}

async function loadLayer(key) {
    setStatus('warning', `Cargando ${layersConfig[key].name}...`);
    
    try {
        if (layersConfig[key].isRPC) {
            if (key === 'reportes') {
                await loadReportes();
            }
            return;
        }

        const response = await fetch(`${supabaseUrl}/rest/v1/${key}?select=*&limit=2000`, {
            headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`
            }
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const data = await response.json();
        const group = L.layerGroup();
        
        data.forEach(item => {
            if (!item.geom) return;
            
            const geom = typeof item.geom === 'string' ? safeParseJSON(item.geom) : item.geom;
            if (!geom) return;
            
            const style = featureStyle(key);
            const layer = L.geoJSON(geom, {
                style: style,
                pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
                    ...style,
                    radius: 6,
                    weight: 2,
                    fillOpacity: 0.7
                })
            });
            
            if (key === 'barrios' && item.BARRIO) {
                layer.bindTooltip(item.BARRIO, {
                    permanent: false,
                    direction: 'top',
                    offset: [0, -6]
                });
            }
            
            layer.on('click', () => {
                const props = Object.assign({}, item);
                delete props.geom;
                showPopup(layer, props);
            });
            
            group.addLayer(layer);
        });
        
        layerGroups[key] = group;
        group.addTo(map);
        setStatus('success', `${layersConfig[key].name}: ${data.length} elementos`);
        
    } catch (error) {
        console.error(error);
        setStatus('error', `Error cargando ${layersConfig[key].name}`);
    }
}

function featureStyle(key) {
    const color = layersConfig[key].color;
    const type = layersConfig[key].type;
    
    if (type === 'line') {
        return { color: color, weight: 2.5, opacity: 0.9 };
    }
    if (type === 'point') {
        return { color: color, weight: 2, opacity: 1, fillColor: color, fillOpacity: 0.8 };
    }
    return { color: color, weight: 2, opacity: 0.9, fillColor: color, fillOpacity: 0.15 };
}

function showPopup(layer, props) {
    const html = `
        <div style="min-width: 220px;">
            ${Object.entries(props).map(([k, v]) => `<div><strong>${k}:</strong> ${v}</div>`).join('')}
        </div>
    `;
    
    try {
        const center = layer.getBounds ? layer.getBounds().getCenter() : null;
        if (center) {
            L.popup().setLatLng(center).setContent(html).openOn(map);
        }
    } catch (e) {}
}

async function loadReportes() {
    try {
        const response = await fetch(`${supabaseUrl}/rest/v1/rpc/obtener_reportes`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`
            },
            body: JSON.stringify({})
        });
        
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const data = await response.json();
        const group = L.layerGroup();
        
        (data.features || []).forEach(feature => {
            if (!feature.geometry || feature.geometry.type !== 'Point') return;
            
            const [x, y] = feature.geometry.coordinates;
            const marker = L.circleMarker([y, x], {
                ...featureStyle('reportes'),
                radius: 7
            });
            
            const props = feature.properties || {};
            const content = `
                <strong>${props.tipo_requerimiento || 'Reporte'}</strong><br>
                Por: ${props.nombre || '—'}<br>
                ${props.comentarios || ''}<br>
                Estado: ${props.estado || '—'}<br>
                ${props.fecha_creacion ? new Date(props.fecha_creacion).toLocaleString() : ''}
            `;
            
            marker.bindPopup(content);
            group.addLayer(marker);
        });
        
        layerGroups['reportes'] = group;
        group.addTo(map);
        setStatus('success', `Reportes: ${(data.features || []).length} elementos`);
        
    } catch (error) {
        console.error(error);
        setStatus('error', 'Error cargando reportes');
    }
}

async function calcDistances(latlng) {
    try {
        setStatus('warning', 'Calculando distancias...');
        
        const response = await fetch(`${supabaseUrl}/rest/v1/rpc/calcular_distancias`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`
            },
            body: JSON.stringify({
                lat_punto: latlng.lat,
                lng_punto: latlng.lng
            })
        });
        
        const result = await response.json();
        const marker = L.marker(latlng).addTo(map);
        
        marker.bindPopup(`
            <strong>Distancias a Servicios</strong><br>
            Bomberos: ${formatMeters(result.bomberos)}<br>
            Policía: ${formatMeters(result.policia)}<br>
            Salud: ${formatMeters(result.salud)}
        `).openPopup();
        
        setStatus('success', 'Distancias calculadas');
        
    } catch (error) {
        setStatus('error', 'Error calculando distancias');
    }
}

function formatMeters(value) {
    if (value == null) return '—';
    const num = Number(value);
    if (isNaN(num)) return String(value);
    return `${num.toFixed(0)} m`;
}

async function preloadBarrios() {
    try {
        const response = await fetch(`${supabaseUrl}/rest/v1/barrios?select=BARRIO`, {
            headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`
            }
        });
        
        const data = await response.json();
        barriosIndex = [...new Set(data.map(item => item.BARRIO).filter(Boolean))].sort();
        
    } catch (error) {
        console.error('Error cargando barrios:', error);
    }
}

function onSearch(e) {
    const query = e.target.value.trim().toLowerCase();
    const resultsDiv = document.getElementById('search-results');
    
    if (query.length < 2) {
        resultsDiv.classList.remove('show');
        resultsDiv.innerHTML = '';
        return;
    }
    
    const matches = barriosIndex.filter(barrio => 
        barrio.toLowerCase().includes(query)
    ).slice(0, 7);
    
    resultsDiv.innerHTML = matches.map(barrio => 
        `<div data-name="${barrio}">${barrio}</div>`
    ).join('');
    
    resultsDiv.classList.add('show');
    
    resultsDiv.querySelectorAll('div').forEach(div => {
        div.addEventListener('click', () => selectBarrio(div.dataset.name));
    });
}

async function selectBarrio(name) {
    document.getElementById('search-input').value = name;
    const resultsDiv = document.getElementById('search-results');
    resultsDiv.classList.remove('show');
    resultsDiv.innerHTML = '';
    
    setStatus('warning', 'Localizando barrio...');
    
    try {
        const url = `${supabaseUrl}/rest/v1/barrios?select=geom,BARRIO&BARRIO=eq.${encodeURIComponent(name)}&limit=1`;
        const response = await fetch(url, {
            headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`
            }
        });
        
        const data = await response.json();
        
        if (data.length && data[0].geom) {
            const geom = typeof data[0].geom === 'string' ? safeParseJSON(data[0].geom) : data[0].geom;
            if (geom) {
                const layer = L.geoJSON(geom);
                map.fitBounds(layer.getBounds(), { padding: [20, 20] });
            }
        }
        
        try {
            const analysisResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/analizar_barrio_completo`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': supabaseKey,
                    'Authorization': `Bearer ${supabaseKey}`
                },
                body: JSON.stringify({ nombre_barrio: name })
            });
            
            const analysisResult = await analysisResponse.json();
            if (!analysisResult.error) {
                setStatus('success', 
                    `Alcantarillado: ${analysisResult.longitud_alcantarillado} m · ` +
                    `Bomberos: ${analysisResult.bomberos} · ` +
                    `Policía: ${analysisResult.policia} · ` +
                    `Salud: ${analysisResult.salud}`
                );
            }
        } catch (e) {}
        
    } catch (error) {
        setStatus('error', 'No se pudo localizar el barrio');
    }
}

function clearReportLocation() {
    reportLocation = null;
    if (reportMarker) {
        map.removeLayer(reportMarker);
        reportMarker = null;
    }
    updateCoordsDisplay();
}

function updateCoordsDisplay() {
    const coordsText = document.getElementById('coords-text');
    const coordsDisplay = document.querySelector('.coords-display');
    
    if (reportLocation) {
        coordsText.textContent = `${reportLocation.lat.toFixed(6)}, ${reportLocation.lng.toFixed(6)}`;
        coordsDisplay.classList.add('selected');
    } else {
        coordsText.textContent = 'No seleccionada';
        coordsDisplay.classList.remove('selected');
    }
}

function getCurrentLocationForReport() {
    if (!navigator.geolocation) {
        setStatus('error', 'Geolocalización no disponible');
        return;
    }
    
    setStatus('warning', 'Obteniendo ubicación actual...');
    
    navigator.geolocation.getCurrentPosition(
        (position) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            setReportLocation({ lat, lng });
            map.setView([lat, lng], 16);
            setStatus('success', 'Ubicación actual obtenida');
        },
        (error) => {
            setStatus('error', 'No se pudo obtener la ubicación actual');
        },
        {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 60000
        }
    );
}

function startMapPicking() {
    mapPickingMode = true;
    map.getContainer().classList.add('map-picking');
    setStatus('warning', 'Haz clic en el mapa para seleccionar la ubicación del reporte');
}

function stopMapPicking() {
    mapPickingMode = false;
    map.getContainer().classList.remove('map-picking');
}

function setReportLocationFromMap(latlng) {
    stopMapPicking();
    setReportLocation(latlng);
    setStatus('success', 'Ubicación seleccionada en el mapa');
}

function setReportLocation(latlng) {
    reportLocation = latlng;
    
    if (reportMarker) {
        map.removeLayer(reportMarker);
    }
    
    reportMarker = L.marker([latlng.lat, latlng.lng], {
        icon: L.icon({
            iconUrl: 'data:image/svg+xml;base64,' + btoa(`
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ef4444">
                    <path d="M12 0C7.58 0 4 3.58 4 8c0 5.5 8 16 8 16s8-10.5 8-16c0-4.42-3.58-8-8-8zm0 11c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3z"/>
                </svg>
            `),
            iconSize: [30, 30],
            iconAnchor: [15, 30],
            popupAnchor: [0, -30]
        })
    }).addTo(map);
    
    reportMarker.bindTooltip('Ubicación del reporte', { permanent: false }).openTooltip();
    updateCoordsDisplay();
}

function setManualCoords() {
    const latInput = document.getElementById('lat-input');
    const lngInput = document.getElementById('lng-input');
    
    const lat = parseFloat(latInput.value);
    const lng = parseFloat(lngInput.value);
    
    if (isNaN(lat) || isNaN(lng)) {
        setStatus('error', 'Ingresa coordenadas válidas');
        return;
    }
    
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        setStatus('error', 'Coordenadas fuera de rango válido');
        return;
    }
    
    setReportLocation({ lat, lng });
    map.setView([lat, lng], 16);
    setStatus('success', 'Coordenadas fijadas manualmente');
}

function resetReportForm() {
    document.getElementById('nombre').value = '';
    document.getElementById('tipo').value = '';
    document.getElementById('comentarios').value = '';
    document.getElementById('lat-input').value = '';
    document.getElementById('lng-input').value = '';
    clearReportLocation();
    stopMapPicking();
}

async function sendReport() {
    const nombre = document.getElementById('nombre').value.trim();
    const tipo = document.getElementById('tipo').value;
    const comentarios = document.getElementById('comentarios').value.trim();
    
    if (!nombre || !tipo || !comentarios) {
        setStatus('error', 'Completa todos los campos obligatorios');
        return;
    }
    
    if (!reportLocation) {
        setStatus('error', 'Selecciona una ubicación para el reporte');
        return;
    }
    
    const sendButton = document.getElementById('report-send');
    sendButton.disabled = true;
    sendButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando...';
    
    try {
        setStatus('warning', 'Enviando reporte...');
        
        const response = await fetch(`${supabaseUrl}/rest/v1/rpc/insertar_reporte`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`
            },
            body: JSON.stringify({
                p_nombre: nombre,
                p_tipo_requerimiento: tipo,
                p_comentarios: comentarios,
                p_lat: reportLocation.lat,
                p_lng: reportLocation.lng
            })
        });
        
        const result = await response.json();
        
        if (result.success !== false) {
            setStatus('success', 'Reporte enviado correctamente');
            resetReportForm();
            
            if (layerGroups['reportes']) {
                map.removeLayer(layerGroups['reportes']);
                delete layerGroups['reportes'];
                await loadReportes();
            }
        } else {
            setStatus('error', 'No se pudo enviar el reporte');
        }
        
    } catch (error) {
        console.error('Error enviando reporte:', error);
        setStatus('error', 'Error de conexión al enviar reporte');
    } finally {
        sendButton.disabled = false;
        sendButton.innerHTML = '<i class="fas fa-paper-plane"></i> Enviar Reporte';
    }
}

function setStatus(type, message) {
    const statusPanel = document.getElementById('status');
    statusPanel.className = `status-panel show ${type}`;
    
    const icons = {
        success: 'fas fa-check-circle',
        error: 'fas fa-exclamation-circle',
        warning: 'fas fa-exclamation-triangle',
        info: 'fas fa-info-circle'
    };
    
    statusPanel.innerHTML = `<i class="${icons[type]}"></i> ${message}`;
    
    setTimeout(() => {
        statusPanel.classList.remove('show');
    }, 5000);
}

function safeParseJSON(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

window.addEventListener('load', init);