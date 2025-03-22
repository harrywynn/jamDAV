require('dotenv-extended').load({
    encoding: 'utf8',
    silent: false,
    path: './.env',
    defaults: './.env.defaults',
    schema: './.env.schema',
    errorOnMissing: true,
    errorOnExtra: true,
    assignToProcessEnv: true,
    overrideProcessEnv: false
});

const db = require('better-sqlite3')('jam.db');
db.pragma('journal_mode = WAL');

const moment = require('moment');
moment.suppressDeprecationWarnings = true;

const RRule = require('rrule').RRule;
const axios = require('axios');
const async = require('async');
const fs = require('fs');

const REFRESH_TOKEN = fs.readFileSync('./token.txt', 'utf8').trim();

if (!REFRESH_TOKEN) {
    console.error('Create a "token.txt" file containing your refresh token.  View README.md for more ino.');
    process.exit(1);
}

let ACCESS_TOKEN = '';

let recurring = {};
let tracked = [];


async.series([
    function(cb) {
        try {
            // create table if necessary
            const stmt = db.prepare('CREATE TABLE IF NOT EXISTS `calendar` (`id` INT not null, `dtstart` datetime null default CURRENT_TIMESTAMP, `dtend` DATETIME null, `name` varchar(255) null, `location` varchar(255) null, `description` TEXT null, `repeat` varchar(255) null, `except` TEXT null, primary key (`id`))');
            stmt.run();
            cb();
        } catch (err) {
            cb(err);
        }
    },
    function(cb) {
        // get an updated access token
        axios.post('https://api.jamfamilycalendar.com/v1/refresh-token', {
            refresh_token: REFRESH_TOKEN
        }, {
            headers: {
                'Client_id': process.env.CLIENT_ID,
                'Client_secret': process.env.CLIENT_SECRET
            }
        })
        .then((response) => {
            if (response.status == 200) {
                ACCESS_TOKEN = response.data.result.access_token;

                // save the updated refresh token for later
                fs.writeFileSync('./token.txt', response.data.result.refresh_token);

                cb();
            } else {
                cb(new Error(response.error));
            }
        }, (err) => {
            cb(err);
        });
    },
    function(cb) {
        // get all of the events for the next year
        let months = [];

        for (let x = 0; x < 12; x++) {
            let monthStart = moment().add(x, 'months').startOf('month').format('YYYY-MM-DD');
            let monthEnd = moment().add(x, 'months').endOf('month').format('YYYY-MM-DD');
            months.push(monthStart + '|' + monthEnd);
        }

        async.forEachSeries(months, function(month, finish) {
            let parts = month.split('|');

            let url = 'https://api.jamfamilycalendar.com/v1/events?start_time=' + parts[0] + '+00%3A00%3A00.000+-0400&end_time=' + parts[1] + '+23%3A59%3A59.999+-0500';

            axios.get(url, {
                headers: {
                    'Authorization': ('Bearer ' + ACCESS_TOKEN),
                    'Client_id': process.env.CLIENT_ID,
                    'Client_secret': process.env.CLIENT_SECRET
                }
            }).then(response => {
                if (response.status == 200) {
                    if (response.data.result) {
                        for (let item of response.data.result) {
                            // track recurring events
                            if (item.recurrence_enabled && item.recurrence_frequency) {
                                let active = recurring[item.id] || [];
                                active.push(moment(item.start_time).format('YYYY-MM-DD'));
                                recurring[item.id] = active;
                            }

                            // don't need the main event if already found
                            if (tracked.includes(item.id)) {
                                continue;
                            }

                            let insert = {
                                id: item.id,
                                dtstart: moment(item.start_time).format('YYYY-MM-DD HH:mm:ss'),
                                dtend: (item.end_time ? moment(item.end_time).format('YYYY-MM-DD HH:mm:ss') : null),
                                name: item.name,
                                location: item.location,
                                description: item.description,
                                repeat: null,
                                except: null
                            };

                            if (item.all_day) {
                                insert.dtstart = moment(item.start_time).format('YYYY-MM-DD 00:00:00');
                                insert.dtend = moment(item.start_time).add(1, 'days').format('YYYY-MM-DD 00:00:00');
                            }

                            if (item.recurrence_enabled && item.recurrence_frequency) {
                                insert.repeat = (item.recurrence_frequency + '|' + (item.recurrence_interval || 1) + '|' + (item.recurrence_until || 0));

                                //if (item.recurrence_until) {
                                    //insert.dtend = moment(item.recurrence_until).format('YYYY-MM-DD 23:59:59');
                                //}

                                let active = recurring[item.id] || [];

                                if (!active.includes(moment(item.start_time).format('YYYY-MM-DD'))) {
                                    active.push(moment(item.start_time).format('YYYY-MM-DD'));
                                }
                                
                                recurring[item.id] = active;
                            }

                            const stmt = db.prepare('INSERT OR REPLACE INTO calendar VALUES (@id, @dtstart, @dtend, @name, @location, @description, @repeat, @except)');
                            stmt.run(insert);

                            // track for later to determine active events
                            tracked.push(item.id);
                        }
                    }

                    finish();
                } else {
                    finish(new Error(response.error));
                }
            })
            .catch((error) => {
                finish(new Error(error));
            });
        }, function(err) {
            cb(err);
        });
    },
    function(cb) {
        try {
            // remove any deleted events
            const stmt = db.prepare(`DELETE FROM calendar WHERE id NOT IN (${tracked.join(',')})`);
            stmt.run();
            cb();
        } catch (err) {
            cb(err);
        }
    },
    function(cb) {
        try {
            // process reccurring events
            const events = db.prepare('SELECT * FROM calendar WHERE `repeat` IS NOT NULL');
            const rows = events.all();

            for (let row of rows) {
                if (!recurring[row.id]) {
                    continue;
                }

                //let endDate = moment(row.dtend).add(11, 'months');
                let repeat = row.repeat.split('|');
                let startDate = moment(row.dtstart);
                let dates = recurring[row.id];
                let except = [];

                let endDate = moment(row.dtend);

                if (repeat[2] != '0') {
                    endDate = moment(repeat[2]);
                } else {
                    endDate = moment(row.dtend).add(11, 'months');
                }

                while (startDate.isBefore(endDate)) {
                    if (!dates.includes(startDate.format('YYYY-MM-DD'))) {
                        // individual event in series was deleted
                        except.push(startDate.format('YYYYMMDD') + 'T' + moment(row.dtstart).format('HHmmss'));
                    }

                    if (repeat[0] == 'DAILY') {
                        startDate = startDate.add(repeat[1], 'days');
                    } else if (repeat[0] == 'WEEKLY') {
                        startDate = startDate.add(repeat[1], 'weeks');
                    } else if (repeat[0] == 'YEARLY') {
                        startDate = startDate.add(repeat[1], 'years');
                    }
                }

                const update = db.prepare('UPDATE calendar SET `except` = @except WHERE id = @id');
                update.run({
                    id: row.id,
                    except: (except.length > 0 ? except.join(',') : null)
                });
            }

            cb();
        } catch (err) {
            cb(err);
        }
    },
    function(cb) {
        // create .ics files for calDAV server
        const now = (moment().format('YYYYMMDD') + 'T' + moment().format('HHmmss') + 'Z');

        let ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//harrywynn.dev//HARRY IS AWESOME
CALSCALE:GREGORIAN
BEGIN:VTIMEZONE
TZID:America/New_York
LAST-MODIFIED:${now}
TZURL:https://www.tzurl.org/zoneinfo-outlook/America/New_York
X-LIC-LOCATION:America/New_York
BEGIN:DAYLIGHT
TZNAME:EDT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZNAME:EST
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
%JAM_EVENTS%END:VCALENDAR`;
    
        try {
            const events = db.prepare('SELECT * FROM calendar');
            const rows = events.all();

            for (let item of rows) {
                let jam = 'BEGIN:VEVENT\n';
                jam += ('DTSTAMP:' + moment().format('YYYYMMDD') + 'T' + moment().format('HHmmss') + 'Z\n');
                jam += ('UID:jam_' + item.id + '\n');
                jam += ('SUMMARY:' + item.name + '\n');
                jam += ('DESCRIPTION:' + (item.description ? item.description.split('\n').join('\\n') : '') + '\n');
                jam += ('LOCATION:' + (item.location || '') + '\n');
                
                if (item.repeat) {
                    // adjust time for zone
                    let hours = (moment(item.dtstart).toDate().toString().indexOf('Daylight') > 0 ? 4 : 5);
                    item.dtstart = moment(item.dtstart).subtract(hours, 'hours').format('YYYY-MM-DD HH:mm:ss');

                    let parts = item.repeat.split('|');

                    const rule = new RRule({
                        freq: RRule[parts[0]],
                        interval: parts[1],
                        tzid: 'America/New_York',
                        dtstart: moment(item.dtstart).toDate(),
                        until: (parts[2] == '0' ? null : moment(parts[2]).toDate())
                    });

                    jam += (rule.toString() + '\n');

                    if (item.except) {
                        jam += ('EXDATE;TZID=America/New_York:' + item.except + '\n');
                    }
                } else {
                    if (item.dtend) {
                        jam += ('DTSTART;TZID=America/New_York:' + moment(item.dtstart).format('YYYYMMDD') + 'T' + moment(item.dtstart).format('HHmmss') + '\n');
                    } else {
                        jam += ('DTSTART;VALUE=DATE:' + moment(item.dtstart).format('YYYYMMDD') + 'T00:00:00\n');
                    }
                }

                if (item.dtend) {
                    jam += ('DTEND;TZID=America/New_York:' + moment(item.dtend).format('YYYYMMDD') + 'T' + moment(item.dtend).format('HHmmss') + '\n');
                } else {
                    jam += ('DTEND;VALUE=DATE:' + moment(item.dtstart).add(1, 'days').format('YYYYMMDD') + 'T00:00:00\n');
                }

                jam += ('END:VEVENT\n');

                const feed = ics.replace('%JAM_EVENTS%', jam);
                fs.writeFileSync((process.env.ICS_PATH + '/' + item.id + '.ics'), feed);
            }

            cb();
        } catch (err) {
            cb(err);
        }
    },
    function(cb) {
        // delete any .ics files for any events that have been deleted
        try {
            const events = db.prepare('SELECT id FROM calendar');
            const rows = events.all();

            const files = fs.readdirSync(process.env.ICS_PATH);
            let ids = [];

            for (let row of rows) {
                ids.push(row.id + '.ics');
            }

            for (let file of files) {
                if (file.indexOf('.ics') < 0) {
                    continue;
                }

                if (!ids.includes(file) && fs.existsSync(process.env.ICS_PATH + '/' + file)) {
                    fs.unlinkSync(process.env.ICS_PATH + '/' + file);
                }
            }
        } catch (err) {
            cb(err);
        }
    }
], function(err) {
    if (err) {
        console.error(err);
        process.exit(1);
    } else {
	    console.log('JAMMED');
        process.exit(0);
    }
})
