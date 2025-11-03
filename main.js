// Configuration
const margin = {top: 10, right: 10, bottom: 10, left: 10};
const width = 1400 - margin.left - margin.right;
const height = 550 - margin.top - margin.bottom;

let data = [];
let geoData = null;
let currentDataType = 'ipc';
let conflictDataMap = new Map();
let fatalityDataMap = new Map();
let conflictMax = 0;
let fatalityMax = 0;
let currentCountry = 'all';
let currentTimeIndex = 0;
let svg = null;
let g = null;
let projection = null;
let path = null;
let regions = null;
let isPlaying = false;
let playInterval = null;

// Time series variables
let timeSeriesSvg = null;
let timeSeriesG = null;
let selectedFeatureIndex = null;
let timeLine = null;
let ipcLine = null;
let soilLine = null;
let ipcAxis = null;
let soilAxis = null;

// Country ranges (starting row index and count)
const countryRanges = {
    '0': { name: 'Somalia', start: 0, count: 199 },
    '1': { name: 'Ethiopia', start: 199, count: 1141 },
    '2': { name: 'Burundi', start: 1340, count: 46 },
    '3': { name: 'South Sudan', start: 1386, count: 81 },
    '4': { name: 'Uganda', start: 1467, count: 318 },
    '5': { name: 'Rwanda', start: 1785, count: 30 },
    '6': { name: 'Kenya', start: 1815, count: 640 },
    '7': { name: 'Sudan', start: 2455, count: 361 }
};

// Color scales
const ipcScale = d3.scaleSequential(d3.interpolateYlOrRd).domain([1, 5]);
const soilScale = d3.scaleSequential(d3.interpolateGreens)
    .domain([-0.1, 0.2])
    .clamp(true);
// Heatmap scales for conflict/fatalities: cap at 0-100 for better visual contrast
let conflictScale = d3.scaleSequentialSqrt(d3.interpolatePurples).domain([0, 100]).clamp(true);
let fatalityScale = d3.scaleSequentialSqrt(d3.interpolateOranges).domain([0, 100]).clamp(true);

// Time periods (extracted from CSV headers)
const timePeriods = [
    '200907', '200910', '201001', '201004', '201007', '201010', '201101', '201104', 
    '201107', '201110', '201201', '201204', '201207', '201210', '201301', '201304', 
    '201307', '201310', '201401', '201404', '201407', '201410', '201501', '201504', 
    '201507', '201510', '201602', '201606', '201610', '201702', '201706', '201710', 
    '201802', '201806', '201810', '201902', '201906', '201910', '202002', 
    '202006', '202010', '202102', '202106', '202110', '202202', '202206', '202210', 
    '202302', '202306', '202310'
];

// Load data files
async function loadData() {
    try {
        // Load CSV data
        const csvData = await d3.csv("fsc_with_soil_moisture.csv");
        csvData.forEach(function(d) {
            // Convert all numeric columns to numbers
            for (let key in d) {
                if (key !== 'int_id') {
                    d[key] = +d[key];
                }
            }
        });
        data = csvData;

        // Load conflict and fatality datasets
        const [conflictCsv, fatalityCsv] = await Promise.all([
            d3.csv("conflict_counts_by_fsc.csv"),
            d3.csv("fatality_counts_by_fsc.csv")
        ]);
        // Coerce numbers and build maps
        conflictCsv.forEach(row => {
            for (let key in row) {
                if (key !== 'int_id') row[key] = +row[key];
            }
            conflictDataMap.set(+row.int_id, row);
        });
        fatalityCsv.forEach(row => {
            for (let key in row) {
                if (key !== 'int_id') row[key] = +row[key];
            }
            fatalityDataMap.set(+row.int_id, row);
        });
        // Compute robust upper bounds (p95) for domains to improve contrast
        const collectValues = (rows) => {
            const arr = [];
            rows.forEach(r => {
                timePeriods.forEach(p => {
                    const v = r[p] ?? r[p + '_count'];
                    if (v !== 99 && !isNaN(v)) arr.push(+v);
                });
            });
            return arr;
        };
        const conflictVals = collectValues(conflictCsv);
        const fatalityVals = collectValues(fatalityCsv);
        conflictMax = conflictVals.length ? d3.max(conflictVals) : 1;
        fatalityMax = fatalityVals.length ? d3.max(fatalityVals) : 1;
        // Note: heatmap scales remain capped at [0,100]; these maxima are used for time series axes only

        // Diagnostics
        console.log('Loaded conflict rows:', conflictCsv.length, 'map size:', conflictDataMap.size, 'max:', conflictMax);
        console.log('Loaded fatality rows:', fatalityCsv.length, 'map size:', fatalityDataMap.size, 'max:', fatalityMax);
        const sampleId = data.length ? +data[0].int_id : null;
        if (sampleId != null) {
            const cRow = conflictDataMap.get(sampleId);
            const fRow = fatalityDataMap.get(sampleId);
            const samplePeriod = timePeriods[0];
            console.log('Sample int_id:', sampleId, 'period:', samplePeriod, 'conflict val:', cRow ? cRow[samplePeriod] : undefined, 'fatality val:', fRow ? fRow[samplePeriod] : undefined);
        }

        // Load GeoJSON data
        geoData = await d3.json("fsc_aggregated.geojson");
        
        // Initialize time slider
        initializeTimeSlider();
        
        // Draw the map
        drawMap();
    } catch (error) {
        console.error('Error loading data:', error);
    }
}


// Debounce function for smooth slider interaction
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Initialize time slider and play button
function initializeTimeSlider() {
    const timeSlider = d3.select('#timeSlider');
    const timeLabel = d3.select('#timeLabel');
    const playButton = d3.select('#playButton');
    const playIcon = d3.select('.play-icon');
    const pauseIcon = d3.select('.pause-icon');
    
    // Create debounced update function for manual slider interaction
    const debouncedUpdate = debounce(() => {
        updateMapColors();
        updateTimeLine();
    }, 50); // 50ms debounce for smooth manual interaction
    
    // Create immediate update function for animation
    const immediateUpdate = () => {
        updateMapColors();
        updateTimeLine();
    };
    
    timeSlider
        .attr('max', timePeriods.length - 1)
        .on('input', function() {
            currentTimeIndex = +this.value;
            const timePeriod = timePeriods[currentTimeIndex];
            timeLabel.text(formatTimePeriod(timePeriod));
            
            // Use debounced update for manual interaction
            debouncedUpdate();
        });
    
    // Play button functionality
    playButton.on('click', function() {
        if (isPlaying) {
            pauseAnimation();
        } else {
            startAnimation();
        }
    });
    
    // Set initial time label
    timeLabel.text(formatTimePeriod(timePeriods[0]));
    
    // Store the immediate update function for animation use
    window.animationUpdate = immediateUpdate;
}

// Start animation
function startAnimation() {
    isPlaying = true;
    const playIcon = d3.select('.play-icon');
    const pauseIcon = d3.select('.pause-icon');
    
    playIcon.style('display', 'none');
    pauseIcon.style('display', 'inline');
    
    playInterval = setInterval(() => {
        currentTimeIndex = (currentTimeIndex + 1) % timePeriods.length;
        
        // Update all elements simultaneously
        const timePeriod = timePeriods[currentTimeIndex];
        
        // Update slider position
        d3.select('#timeSlider').property('value', currentTimeIndex);
        
        // Update time label
        d3.select('#timeLabel').text(formatTimePeriod(timePeriod));
        
        // Update map colors immediately (no transition for animation)
        updateMapColors(false);
        
        // Update time line immediately for animation
        updateTimeLine();
        
        // Stop at the end and reset
        if (currentTimeIndex === 0) {
            pauseAnimation();
        }
    }, 800); // 800ms per frame for smooth animation
}

// Pause animation
function pauseAnimation() {
    isPlaying = false;
    const playIcon = d3.select('.play-icon');
    const pauseIcon = d3.select('.pause-icon');
    
    playIcon.style('display', 'inline');
    pauseIcon.style('display', 'none');
    
    if (playInterval) {
        clearInterval(playInterval);
        playInterval = null;
    }
}

// Format time period for display
function formatTimePeriod(period) {
    const year = period.substring(0, 4);
    const month = period.substring(4, 6);
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${year}-${monthNames[parseInt(month) - 1]}`;
}

// Get current time column name
function getCurrentTimeColumn() {
    const timePeriod = timePeriods[currentTimeIndex];
    if (currentDataType === 'ipc') return timePeriod;
    if (currentDataType === 'sif') return timePeriod + '_sm';
    return timePeriod; // conflict/fatality use separate maps keyed by period
}

// Create map projection
function createProjection() {
    // Calculate bounds of the data
    const bounds = d3.geoBounds(geoData);
    const center = d3.geoCentroid(geoData);
    
    // Create projection centered on the data with better fit, shifted left
    const projection = d3.geoMercator()
        .center(center)
        .scale(1000)
        .translate([width / 2 - 400, height / 2]);
    
    return projection;
}

// Get data for a specific feature index
function getDataForFeature(featureIndex) {
    if (currentCountry === 'all') {
        return data[featureIndex];
    }
    
    const range = countryRanges[currentCountry];
    const localIndex = featureIndex - range.start;
    
    // Check if this feature is within the selected country's range
    if (localIndex >= 0 && localIndex < range.count) {
        return data[featureIndex];
    }
    
    return null; // Feature not in selected country
}

// Initialize the map (called once)
function initializeMap() {
    if (!data.length || !geoData) return;
    
    // Clear existing
    d3.select('#map').selectAll('*').remove();
    
    // Create projection
    projection = createProjection();
    path = d3.geoPath().projection(projection);
    
    // Create SVG
    svg = d3.select('#map')
        .append('svg')
        .attr('width', width + margin.left + margin.right)
        .attr('height', height + margin.top + margin.bottom)
        .on('click', function(event) {
            // Close time series if clicking on empty map area
            if (selectedFeatureIndex !== null) {
                hideTimeSeries();
            }
        });
    
    g = svg.append('g')
        .attr('transform', `translate(${margin.left},${margin.top})`);
    
    // Draw regions once
    regions = g.selectAll('.region')
        .data(geoData.features)
        .enter()
        .append('path')
        .attr('class', 'region')
        .attr('d', path)
        .on('mouseover', function(event, d) {
            const featureIndex = geoData.features.indexOf(d);
            const csvData = getDataForFeature(featureIndex);
            if (csvData) {
                const currentColumn = getCurrentTimeColumn();
                let value;
                if (currentDataType === 'ipc') {
                    value = csvData[currentColumn];
                } else if (currentDataType === 'sif') {
                    value = csvData[currentColumn];
                } else if (currentDataType === 'conflict') {
                    const row = conflictDataMap.get(+csvData.int_id);
                    value = row ? (row[currentColumn] ?? row[currentColumn + '_count']) : NaN;
                } else if (currentDataType === 'fatality') {
                    const row = fatalityDataMap.get(+csvData.int_id);
                    value = row ? (row[currentColumn] ?? row[currentColumn + '_count']) : NaN;
                }
                if (value !== 99 && !isNaN(value)) {
                    showTooltip(event, csvData.int_id, timePeriods[currentTimeIndex], value);
                }
            }
        })
        .on('mouseout', hideTooltip)
        .on('click', function(event, d) {
            event.stopPropagation(); // Prevent event from bubbling to SVG
            const featureIndex = geoData.features.indexOf(d);
            const csvData = getDataForFeature(featureIndex);
            if (csvData) {
                // Remove selected class from all regions
                regions.classed('selected', false);
                // Add selected class to clicked region
                d3.select(this).classed('selected', true);
                showTimeSeries(featureIndex);
            }
        });
    
    // Add country borders
    g.selectAll('.country-border')
        .data(geoData.features)
        .enter()
        .append('path')
        .attr('class', 'country-border')
        .attr('d', path)
        .attr('fill', 'none')
        .attr('stroke', '#333')
        .attr('stroke-width', 0.5);
    
    // Initial color update
    updateMapColors();
    
    // Initialize legend
    updateLegend();
}

// Update map colors (called when data type, country, or time changes)
function updateMapColors(useTransition = true) {
    if (!regions) return;
    
    const currentColumn = getCurrentTimeColumn();
    const colorScale = currentDataType === 'ipc' ? ipcScale : (currentDataType === 'sif' ? soilScale : (currentDataType === 'conflict' ? conflictScale : fatalityScale));
    
    const updateFunction = (selection) => {
        selection.attr('fill', (d, i) => {
            const csvData = getDataForFeature(i);
            if (!csvData) return '#f0f0f0';
            let value;
            if (currentDataType === 'ipc') {
                value = csvData[currentColumn];
            } else if (currentDataType === 'sif') {
                value = csvData[currentColumn];
            } else if (currentDataType === 'conflict') {
                const row = conflictDataMap.get(+csvData.int_id);
                if (row) {
                    value = row[currentColumn];
                    if (value === undefined) {
                        // Try common alternate header patterns
                        value = row[currentColumn + '_count'];
                    }
                } else {
                    value = NaN;
                }
            } else if (currentDataType === 'fatality') {
                const row = fatalityDataMap.get(+csvData.int_id);
                if (row) {
                    value = row[currentColumn];
                    if (value === undefined) {
                        value = row[currentColumn + '_count'];
                    }
                } else {
                    value = NaN;
                }
            }
            
            // Handle invalid/no data values
            if (isNaN(value) || value === 99) return '#ccc';
            // Ensure exact zero renders as white for non-IPC datasets
            if (value === 0 && currentDataType !== 'ipc') return '#ffffff';
            
            // For IPC data, only color values 1-5, everything else is gray (no data)
            if (currentDataType === 'ipc' && (value < 1 || value > 5)) {
                return '#ccc';
            }
            
            return colorScale(value);
        });
    };
    
    if (useTransition && !isPlaying) {
        // Use transition for manual interactions
        regions.transition().duration(300).call(updateFunction);
    } else {
        // Immediate update for animation
        regions.call(updateFunction);
    }
}

// Update legend
function updateLegend() {
    const legendContent = d3.select('#legendContent');
    legendContent.selectAll('*').remove();
    
    const colorScale = currentDataType === 'ipc' ? ipcScale : (currentDataType === 'sif' ? soilScale : (currentDataType === 'conflict' ? conflictScale : fatalityScale));
    const isIPC = currentDataType === 'ipc';
    
    if (isIPC) {
        // IPC Legend
        const ipcLevels = [
            { value: 1, label: 'Minimal', color: colorScale(1) },
            { value: 2, label: 'Stressed', color: colorScale(2) },
            { value: 3, label: 'Crisis', color: colorScale(3) },
            { value: 4, label: 'Emergency', color: colorScale(4) },
            { value: 5, label: 'Famine', color: colorScale(5) }
        ];
        
        const legendItems = legendContent.selectAll('.legend-item')
            .data(ipcLevels)
            .enter()
            .append('div')
            .attr('class', 'legend-item');
        
        legendItems.append('div')
            .attr('class', 'legend-color')
            .style('background-color', d => d.color);
        
        legendItems.append('span')
            .text(d => `${d.value} - ${d.label}`);
    } else {
        // Legend for non-IPC datasets
        let soilLevels;
        if (currentDataType === 'sif') {
            // Use SIF domain; label with < and > at the bounds
            const domain = soilScale.domain();
            const minVal = domain[0];
            const maxVal = domain[1];
            const range = maxVal - minVal;
            const q25 = minVal + range * 0.25;
            const q50 = minVal + range * 0.5;
            const q75 = minVal + range * 0.75;
            soilLevels = [
                { value: minVal, label: `< ${minVal.toFixed(2)}`, color: soilScale(minVal) },
                { value: q25, label: `${q25.toFixed(2)}`, color: soilScale(q25) },
                { value: q50, label: `${q50.toFixed(2)}`, color: soilScale(q50) },
                { value: q75, label: `${q75.toFixed(2)}`, color: soilScale(q75) },
                { value: maxVal, label: `> ${maxVal.toFixed(2)}`, color: soilScale(maxVal) }
            ];
        } else {
            // Conflict/Fatality heatmap legend fixed 0..100
            const domainStops = [0, 25, 50, 75, 100];
            soilLevels = domainStops.map(v => ({
                value: v,
                label: v === 100 ? '> 100' : `${v}`,
                color: colorScale(v)
            }));
        }
        
        const legendItems = legendContent.selectAll('.legend-item')
            .data(soilLevels)
            .enter()
            .append('div')
            .attr('class', 'legend-item');
        
        legendItems.append('div')
            .attr('class', 'legend-color')
            .style('background-color', d => d.color);
        
        legendItems.append('span')
            // .text(d => `${d.label} (${d.value.toFixed(2)})`);
            .text(d => `${d.label}`);
    }
}

// Draw the map (legacy function for compatibility)
function drawMap() {
    if (!svg) {
        initializeMap();
    } else {
        updateMapColors();
    }
}

// Handle country selection change
d3.select('#countrySelect').on('change', function() {
    currentCountry = this.value;
    drawMap();
    updateLegend();
});

// Handle data type change
d3.select('#dataType').on('change', function() {
    currentDataType = this.value;
    drawMap();
    updateLegend();
    // If a unit is currently selected, refresh the time series for the new dataset
    if (selectedFeatureIndex !== null) {
        showTimeSeries(selectedFeatureIndex);
    }
});

// Handle close time series button
d3.select('#closeTimeSeries').on('click', function() {
    if (selectedFeatureIndex !== null) {
        hideTimeSeries();
    }
});

function showTooltip(event, unitId, timestamp, value) {
    const tooltip = d3.select('#tooltip');
    const label = currentDataType === 'ipc' ? 'IPC Level' : (currentDataType === 'sif' ? 'SIF' : (currentDataType === 'conflict' ? 'Conflict' : 'Fatalities'));
    let formattedValue;
    if (currentDataType === 'sif') {
        formattedValue = value.toFixed(2);
    } else if (currentDataType === 'ipc') {
        formattedValue = Math.round(value).toString();
    } else {
        // conflict/fatalities
        formattedValue = Math.round(value).toLocaleString();
    }
    
    tooltip
        .style('display', 'block')
        .style('left', (event.pageX + 10) + 'px')
        .style('top', (event.pageY + 10) + 'px')
        .html(`
            <strong>Unit ${unitId}</strong><br/>
            Time: ${formatTimePeriod(timestamp)}<br/>
            ${label}: ${formattedValue}
        `);
}

function hideTooltip() {
    d3.select('#tooltip').style('display', 'none');
}

// Time series functions
function initializeTimeSeries() {
    const container = d3.select('#timeSeriesChart');
    container.selectAll('*').remove();
    
    const tsMargin = {top: 20, right: 60, bottom: 40, left: 50};
    const tsWidth = 360 - tsMargin.left - tsMargin.right;
    const tsHeight = 450 - tsMargin.top - tsMargin.bottom;
    
    timeSeriesSvg = container
        .append('svg')
        .attr('width', tsWidth + tsMargin.left + tsMargin.right)
        .attr('height', tsHeight + tsMargin.top + tsMargin.bottom);
    
    timeSeriesG = timeSeriesSvg.append('g')
        .attr('transform', `translate(${tsMargin.left},${tsMargin.top})`);
    
    // Create scales
    const xScale = d3.scaleLinear()
        .domain([0, timePeriods.length - 1])
        .range([0, tsWidth]);
    
    const ipcYScale = d3.scaleLinear()
        .domain([1, 5])
        .range([tsHeight, 0]);
    
    // Right axis depends on selected dataset
    const rightDomain = currentDataType === 'sif' ? [-0.1, 0.2] : (currentDataType === 'conflict' ? [0, conflictMax] : [0, fatalityMax]);
    const soilYScale = d3.scaleLinear()
        .domain(rightDomain)
        .range([tsHeight, 0]);
    
    // Create axes
    const xAxis = d3.axisBottom(xScale)
        .tickFormat(d => formatTimePeriod(timePeriods[d]))
        .ticks(8);
    
    ipcAxis = d3.axisLeft(ipcYScale)
        .tickFormat(d => d);
    
    soilAxis = d3.axisRight(soilYScale)
        .tickFormat(d => d.toFixed(2));
    
    // Add axes
    timeSeriesG.append('g')
        .attr('class', 'x-axis')
        .attr('transform', `translate(0,${tsHeight})`)
        .call(xAxis)
        .selectAll('text')
        .style('font-size', '10px')
        .attr('transform', 'rotate(-45)')
        .attr('text-anchor', 'end');
    
    timeSeriesG.append('g')
        .attr('class', 'ipc-axis')
        .call(ipcAxis)
        .append('text')
        .attr('transform', 'rotate(-90)')
        .attr('y', -35)
        .attr('x', -tsHeight/2)
        .attr('text-anchor', 'middle')
        .style('font-size', '12px')
        .style('fill', '#d73027')
        .text('IPC Level');
    
    timeSeriesG.append('g')
        .attr('class', 'soil-axis')
        .attr('transform', `translate(${tsWidth},0)`)
        .call(soilAxis);
    
    // Add right-axis label on the right side
    timeSeriesG.append('text')
        .attr('transform', 'rotate(90)')
        .attr('y', - tsWidth - 40)
        .attr('x', tsHeight/2)
        .attr('text-anchor', 'middle')
        .style('font-size', '12px')
        .style('fill', currentDataType === 'sif' ? '#2ca25f' : (currentDataType === 'conflict' ? '#762a83' : '#000000'))
        .text(currentDataType === 'sif' ? 'SIF' : (currentDataType === 'conflict' ? 'Conflict' : 'Fatalities'));
    
    // Create line generators
    ipcLine = d3.line()
        .x((d, i) => xScale(i))
        .y(d => ipcYScale(d))
        .defined(d => d !== null && !isNaN(d))
        .curve(d3.curveMonotoneX);
    
    soilLine = d3.line()
        .x((d, i) => xScale(i))
        .y(d => soilYScale(d))
        .defined(d => d !== null && !isNaN(d))
        .curve(d3.curveMonotoneX);
    
    // Add vertical time line
    timeLine = timeSeriesG.append('line')
        .attr('class', 'time-line')
        .attr('x1', xScale(currentTimeIndex))
        .attr('x2', xScale(currentTimeIndex))
        .attr('y1', 0)
        .attr('y2', tsHeight)
        .attr('stroke', '#333')
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', '5,5');
}

function showTimeSeries(featureIndex) {
    selectedFeatureIndex = featureIndex;
    const csvData = getDataForFeature(featureIndex);
    
    if (!csvData) return;
    
    // Hide intro text and show time series chart
    d3.select('#introText').style('display', 'none');
    d3.select('#timeSeriesChart').style('display', 'block');
    
    // Show close button
    d3.select('#closeTimeSeries').style('display', 'flex');
    
    // Rebuild time series each time to ensure axes and scales match dataset
    initializeTimeSeries();
    
    // Prepare data for both lines
    const ipcData = [];
    const soilData = [];
    
    timePeriods.forEach((period, i) => {
        const ipcValue = csvData[period];
        let soilValue;
        if (currentDataType === 'sif') {
            soilValue = csvData[period + '_sm'];
        } else if (currentDataType === 'conflict') {
            const row = conflictDataMap.get(+csvData.int_id);
            soilValue = row ? (row[period] !== undefined ? row[period] : row[period + '_count']) : NaN;
        } else if (currentDataType === 'fatality') {
            const row = fatalityDataMap.get(+csvData.int_id);
            soilValue = row ? (row[period] !== undefined ? row[period] : row[period + '_count']) : NaN;
        }
        
        // For IPC data, accept values 1-5, treat 99 and invalid values as null
        if (ipcValue !== 99 && !isNaN(ipcValue) && ipcValue >= 1 && ipcValue <= 5) {
            ipcData.push(ipcValue);
        } else {
            ipcData.push(null);
        }
        
        // Validate right-side series per dataset
        if (currentDataType === 'sif') {
            if (soilValue !== 99 && !isNaN(soilValue) && soilValue >= -0.1 && soilValue <= 0.2) {
                soilData.push(soilValue);
            } else {
                soilData.push(null);
            }
        } else if (currentDataType === 'conflict' || currentDataType === 'fatality') {
            if (soilValue !== 99 && !isNaN(soilValue)) {
                soilData.push(soilValue);
            } else {
                soilData.push(null);
            }
        }
    });
    
    // Clear existing lines
    timeSeriesG.selectAll('.ipc-line').remove();
    timeSeriesG.selectAll('.soil-line').remove();
    
    // Add IPC line
    timeSeriesG.append('path')
        .attr('class', 'ipc-line')
        .datum(ipcData)
        .attr('fill', 'none')
        .attr('stroke', '#d73027')
        .attr('stroke-width', 2)
        .attr('d', ipcLine);
    
    // Add right-side series line
    timeSeriesG.append('path')
        .attr('class', 'soil-line')
        .datum(soilData)
        .attr('fill', 'none')
        .attr('stroke', currentDataType === 'sif' ? '#2ca25f' : (currentDataType === 'conflict' ? '#762a83' : '#000000'))
        .attr('stroke-width', 2)
        .attr('d', soilLine);
    
    // Update time line position
    updateTimeLine();
}

function updateTimeLine() {
    if (!timeLine) return;
    
    const tsWidth = 360 - 50 - 60; // width - left margin - right margin
    const xScale = d3.scaleLinear()
        .domain([0, timePeriods.length - 1])
        .range([0, tsWidth]);
    
    if (isPlaying) {
        // Immediate update for animation
        timeLine
            .attr('x1', xScale(currentTimeIndex))
            .attr('x2', xScale(currentTimeIndex));
    } else {
        // Smooth transition for manual slider interaction
        timeLine
            .transition()
            .duration(300)
            .attr('x1', xScale(currentTimeIndex))
            .attr('x2', xScale(currentTimeIndex));
    }
}

function hideTimeSeries() {
    // Show intro text and hide time series chart
    d3.select('#introText').style('display', 'block');
    d3.select('#timeSeriesChart').style('display', 'none');
    
    // Hide close button
    d3.select('#closeTimeSeries').style('display', 'none');
    
    selectedFeatureIndex = null;
    // Remove selected class from all regions
    if (regions) {
        regions.classed('selected', false);
    }
}

// Initialize
loadData();
