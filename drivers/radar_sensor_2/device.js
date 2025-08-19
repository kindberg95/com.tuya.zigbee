'use strict';

const { debug, Cluster } = require('zigbee-clusters');
const TuyaSpecificCluster = require('../../lib/TuyaSpecificCluster');
const TuyaSpecificClusterDevice = require("../../lib/TuyaSpecificClusterDevice");
const { getDataValue } = require('../../lib/TuyaHelpers');
const { V2_RADAR_SENSOR_DATA_POINTS } = require('../../lib/TuyaDataPoints');

Cluster.addCluster(TuyaSpecificCluster);

class radarSensor2 extends TuyaSpecificClusterDevice {

  async onNodeInit({ zclNode }) {
    this.printNode();
/*     debug(true);
    this.enableDebug(); */

    // Initialize the flow card for target distance changes
    this.targetDistanceTrigger = this.homey.flow.getDeviceTriggerCard('target_distance_changed');

    // Read and log device attributes
    await this._readDeviceAttributes(zclNode);

    // Attach event listeners for Tuya-specific reports (manual state changes)
    if (!this.hasListenersAttached) {
      zclNode.endpoints[1].clusters.tuya.on('reporting', async (value) => {
        try {
          this.log('Received reporting:', value);
          await this.processDatapoint(value);
        } catch (err) {
          this.error('Error processing datapoint:', err);
        }
      });

      zclNode.endpoints[1].clusters.tuya.on('response', async (value) => {
        try {
          this.log('Received response:', value);
          await this.processDatapoint(value);
        } catch (err) {
          this.error('Error processing datapoint:', err);
        }
      });

      this.hasListenersAttached = true;
    }
  }

  async _readDeviceAttributes(zclNode) {
    try {
      await zclNode.endpoints[1].clusters.basic.readAttributes(['manufacturerName', 'zclVersion', 'appVersion', 'modelId', 'powerSource', 'attributeReportingStatus']);
    } catch (err) {
      this.error('Error when reading device attributes:', err);
    }
  }

  // Process DP reports and update Homey accordingly
  async processDatapoint(data) {
    const dp = data.dp;
    const parsedValue = getDataValue(data);
    const dataType = data.datatype;
    this.log(`Processing DP ${dp}, Data Type: ${dataType}, Parsed Value:`, parsedValue);

    switch (dp) {
      case V2_RADAR_SENSOR_DATA_POINTS.presenceState:
        this.log('Received presence state:', parsedValue);
        await this.setCapabilityValue('alarm_motion', parsedValue === true || parsedValue === 1).catch(this.error);
        break;

      case V2_RADAR_SENSOR_DATA_POINTS.radarSensitivity:
        this.log('Received radar sensitivity:', parsedValue);
        break;

      case V2_RADAR_SENSOR_DATA_POINTS.illuminanceLux:
        this.log('Received illuminance value:', parsedValue);
        this.onIlluminanceMeasuredAttributeReport(parsedValue);
        break;

      case V2_RADAR_SENSOR_DATA_POINTS.targetDistance:
        const distanceUpdateInterval = this.getSetting('distance_update_interval') ?? 10;
        if (new Date().getSeconds() % distanceUpdateInterval === 0) {
          this.setCapabilityValue('target_distance', parsedValue / 100).catch(this.error); // converting to meters
          // Trigger the custom flow card for target distance change
          await this.targetDistanceTrigger.trigger(this, { target_distance: parsedValue / 100 }).catch(this.error);
        }
        break;

      default:
        this.log('Unhandled DP:', dp, 'with value:', parsedValue);
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    try {
      if (changedKeys.includes('radar_sensitivity')) {
        await this.writeData32(V2_RADAR_SENSOR_DATA_POINTS.radarSensitivity, newSettings['radar_sensitivity']);
      }
      if (changedKeys.includes('minimum_range')) {
        await this.writeData32(V2_RADAR_SENSOR_DATA_POINTS.minimumRange, newSettings['minimum_range'] * 100); // convert to centimeters
      }
      if (changedKeys.includes('maximum_range')) {
        await this.writeData32(V2_RADAR_SENSOR_DATA_POINTS.maximumRange, newSettings['maximum_range'] * 100); // convert to centimeters
      }
      if (changedKeys.includes('detection_delay')) {
        await this.writeData32(V2_RADAR_SENSOR_DATA_POINTS.detectionDelay, newSettings['detection_delay']);
      }
      if (changedKeys.includes('fading_time')) {
        await this.writeData32(V2_RADAR_SENSOR_DATA_POINTS.fadingTime, newSettings['fading_time']);
      }
    } catch (error) {
      this.error('Error in onSettings:', error);
    }
  }

  onIlluminanceMeasuredAttributeReport(measuredValue) {
    this.log('measure_luminance | Luminance - measuredValue (lux):', measuredValue);
    this.setCapabilityValue('measure_luminance', measuredValue).catch(this.error);
  }

  onDeleted() {
    this.log('Radar sensor removed');
  }
// HOBEIAN ZG-204ZM - mmWave Presence Sensor
{
    model: 'ZG-204ZM',
    vendor: 'HOBEIAN',
    description: 'Battery powered PIR and mmWave presence sensor',
    supports: 'Presence, motion state, illuminance, battery, and configuration',
    fromZigbee: [
        fz.battery, 
        fz.illuminance, 
        fz.ignore_occupancy_report, 
        fz.ignore_presence_report,
        (device, logger) => {
            return {
                hobeian_presence: {
                    cluster: 'genAnalogInput',
                    type: ['attributeReport', 'readResponse'],
                    convert: (model, msg, publish, options, meta) => {
                        const value = msg.data['presentValue'];
                        if (value !== undefined) {
                            return { presence: value > 0 };
                        }
                    },
                },
                hobeian_motion_state: {
                    cluster: 'genMultistateInput',
                    type: ['attributeReport', 'readResponse'],
                    convert: (model, msg, publish, options, meta) => {
                        const value = msg.data['presentValue'];
                        const states = {0: 'none', 1: 'small', 2: 'large', 3: 'static'};
                        return { motion_state: states[value] || 'unknown' };
                    },
                }
            };
        }
    ],
    toZigbee: [
        tz.on_off,
        (device, logger) => {
            return {
                fading_time: {
                    key: ['fading_time'],
                    convertSet: async (entity, key, value, meta) => {
                        await entity.command('genAnalogOutput', 'writeAttributes', {
                            'presentValue': value,
                        }, { disableDefaultResponse: true });
                        return { state: { fading_time: value } };
                    },
                },
                motion_detection_sensitivity: {
                    key: ['motion_detection_sensitivity'],
                    convertSet: async (entity, key, value, meta) => {
                        await entity.command('genAnalogOutput', 'writeAttributes', {
                            'presentValue': value,
                        }, { disableDefaultResponse: true });
                        return { state: { motion_detection_sensitivity: value } };
                    },
                },
                static_detection_distance: {
                    key: ['static_detection_distance'],
                    convertSet: async (entity, key, value, meta) => {
                        await entity.command('genAnalogOutput', 'writeAttributes', {
                            'presentValue': value,
                        }, { disableDefaultResponse: true });
                        return { state: { static_detection_distance: value } };
                    },
                },
                indicator: {
                    key: ['indicator'],
                    convertSet: async (entity, key, value, meta) => {
                        const indicatorValue = value === 'ON' ? 1 : 0;
                        await entity.command('genBinaryOutput', 'writeAttributes', {
                            'presentValue': indicatorValue,
                        }, { disableDefaultResponse: true });
                        return { state: { indicator: value } };
                    },
                },
                illuminance_interval: {
                    key: ['illuminance_interval'],
                    convertSet: async (entity, key, value, meta) => {
                        await entity.command('genAnalogOutput', 'writeAttributes', {
                            'presentValue': value,
                        }, { disableDefaultResponse: true });
                        return { state: { illuminance_interval: value } };
                    },
                }
            };
        }
    ],
    exposes: [
        e.presence(), 
        e.battery(), 
        e.illuminance(), 
        e.illuminance_lux().withUnit('lx'),
        e.numeric('fading_time', ea.STATE_SET).withDescription('Presence keep time in seconds').withUnit('s')
            .withValueMin(0).withValueMax(28800),
        e.numeric('motion_detection_sensitivity', ea.STATE_SET).withDescription('Motion detection sensitivity (0-19)')
            .withValueMin(0).withValueMax(19),
        e.numeric('static_detection_distance', ea.STATE_SET).withDescription('Static detection distance (0-10m)')
            .withValueMin(0).withValueMax(10).withUnit('m'),
        e.binary('indicator', ea.STATE_SET, 'ON', 'OFF').withDescription('LED indicator'),
        e.numeric('illuminance_interval', ea.STATE_SET).withDescription('Illuminance sampling interval in minutes')
            .withValueMin(1).withValueMax(720).withUnit('minutes'),
    ],
    meta: { battery: { voltageToPercentage: '3V_2500' } },
    configure: async (device, coordinatorEndpoint, logger) => {
        const endpoint = device.getEndpoint(1);
        await bind(endpoint, coordinatorEndpoint, ['genPowerCfg', 'msIlluminanceMeasurement']);
        await configureReporting.batteryVoltage(endpoint);
        await configureReporting.batteryPercentageRemaining(endpoint);
        await configureReporting.illuminance(endpoint);
    },
},
},
}

module.exports = radarSensor2;
