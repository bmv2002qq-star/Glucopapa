"""Generate independent DOP853 checkpoints for the published 13-state research equations."""
import json
import math
from pathlib import Path
import sys

from scipy.integrate import solve_ivp


def rate(_minute, state, p, food, insulin, meal_before, meal_received):
    solid, liquid, gut, plasma, tissue, insulin_p, effect, delayed, delayed_2, liver, sc_1, sc_2, sensor = state
    meal_mg = meal_before + 1000 * meal_received
    emptying = p['kmax']
    if meal_mg > 0:
        total = solid + liquid
        upper = 2.5 * (total / meal_mg - p['b']) / (1 - p['b'])
        lower = 2.5 * (total / meal_mg - p['d']) / p['d']
        blend = 1 + 0.5 * (math.tanh(upper) - math.tanh(lower))
        emptying = p['kmin'] + (p['kmax'] - p['kmin']) * blend
    produced = max(0, p['kp1'] - p['kp2'] * plasma - p['kp3'] * delayed_2)
    renal = p['ke1'] * max(0, plasma - p['ke2'])
    transfer = p['k1'] * plasma - p['k2'] * tissue
    plasma_per_volume = insulin_p / p['Vi']
    uptake = (p['Vm0'] + p['Vmx'] * effect) * tissue / (p['Km0'] + tissue)
    return [
        1000 * food - p['kmax'] * solid,
        p['kmax'] * solid - emptying * liquid,
        emptying * liquid - p['kabs'] * gut,
        produced + p['f'] * p['kabs'] * gut / p['BW'] - p['Fsnc'] - renal - transfer if plasma >= 0 else 0,
        transfer - uptake if tissue >= 0 else 0,
        p['m1'] * liver + p['ka1'] * sc_1 + p['ka2'] * sc_2 - (p['m2'] + p['m4']) * insulin_p if insulin_p >= 0 else 0,
        p['p2u'] * (plasma_per_volume - p['Ib'] - effect),
        p['ki'] * (plasma_per_volume - delayed),
        p['ki'] * (delayed - delayed_2),
        p['m2'] * insulin_p - (p['m1'] + p['m30']) * liver if liver >= 0 else 0,
        6000 * insulin / p['BW'] - (p['ka1'] + p['kd']) * sc_1 if sc_1 >= 0 else 0,
        p['kd'] * sc_1 - p['ka2'] * sc_2 if sc_2 >= 0 else 0,
        p['ksc'] * (plasma - sensor) if sensor >= 0 else 0,
    ]


def reference(profile):
    params = profile['physiology']
    state = [profile['initial_states'][f'x0_{i:2}'] for i in range(1, 14)]
    basal = params['u2ss'] * params['BW'] / 6000
    meal_before = meal_received = 0
    checkpoints = {}
    for minute in range(90):
        if minute == 30:
            meal_before = state[0] + state[1]
        food = 5 if 30 <= minute < 34 else 0
        meal_received += food
        insulin = basal + (0.5 if minute == 20 else 0)
        solution = solve_ivp(rate, (minute, minute + 1), state, method='DOP853',
                             args=(params, food, insulin, meal_before, meal_received),
                             rtol=2e-11, atol=1e-12)
        if not solution.success:
            raise RuntimeError(solution.message)
        state = solution.y[:, -1].tolist()
        if minute + 1 in (20, 21, 34, 60, 90):
            checkpoints[minute + 1] = state
    return checkpoints


def main():
    database_script = Path(sys.argv[1]).read_text(encoding='utf-8')
    database, _ = json.JSONDecoder().raw_decode(database_script.split('Object.freeze(', 1)[1])
    values = {profile['id']: reference(profile) for profile in database['profiles']}
    Path(sys.argv[2]).write_text(json.dumps(values, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
