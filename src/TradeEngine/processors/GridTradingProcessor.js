import { AbstractProcessor } from './AbstractProcessor.js';
import { LocalVariable } from '../../LocalVariable.js';
import { createOrder_market, executeOrders, fetchOrders } from '../../trading.js';
import { getGridTradeOrders, recordGridTradeOrders } from '../../recordTools.js';
export class GridTradingProcessor extends AbstractProcessor {
  type = 'GridTradingProcessor';
  engine = null;
  asset_name = '';
  _timer = {};

  // 网格参数
  _grid_width = 0.025; // 网格宽度
  _max_drawdown = 0.012; // 最大回撤
  _max_bounce = 0.012; // 最大反弹
  _trade_amount = 9000; // 每次交易数量
  _max_position = 100000; // 最大持仓
  _min_price = 0.1; // 最低触发价格
  _max_price = 100; // 最高触发价格
  _backoff_1st_time = 30 * 60; // 15 分钟
  _backoff_2nd_time = 60 * 60; // 25 分钟
  _backoff_3nd_time = 90 * 60; // 30 分钟
  // 风险控制
  _max_trade_grid_count = 8; // 最大网格数量
  // 策略锁
  _stratage_locked = false;
  _recent_prices = []; // 最近价格，用于计算波动率
  // 全局变量
  // 全局变量部分添加新的变量
  _grid = [];
  _is_position_created = false;
  _current_price = null;
  _current_price_ts = null;
  _prev_price = null;
  _prev_price_ts = null;
  _last_trade_price = null;
  _last_trade_price_ts = null;
  _last_upper_turning_price = null; // 上拐点价格
  _last_upper_turning_price_ts = null; // 上拐点时间戳
  _last_lower_turning_price = null; // 下拐点价格
  _last_lower_turning_price_ts = null; // 下拐点时间戳
  _grid_base_price = null;
  _grid_base_price_ts = null;
  _tendency = 0;
  _direction = 0;
  _enable_none_grid_trading = false; // 是否启用无网格交易,网格内跨线回撤
  _last_grid_count = 0;
  _last_grid_count_overtime_reset_ts = null;
  _last_reset_grid_count = 0;
  // 外部因子
  factor_is_people_bullish = false;

  constructor(asset_name, params = {}, engine) {
    super();
    this.engine = engine;
    this.asset_name = asset_name;
    this.id = `GridTradingProcessor_${asset_name}`;

    // 初始化参数
    Object.assign(this, params);
    // 初始化本地变量
    this.local_variables = new LocalVariable(`GridTradingProcessor/${this.asset_name}`);

    // 从本地变量恢复状态
    this._loadState();
  }

  _loadState() {
    this._is_position_created = this.local_variables.is_position_created || false;
    this._last_trade_price = this.local_variables.last_trade_price;
    this._last_trade_price_ts = this.local_variables.last_trade_price_ts;
    this._last_lower_turning_price = this.local_variables.last_lower_turning_price;
    this._last_lower_turning_price_ts = this.local_variables.last_lower_turning_price_ts;
    this._last_upper_turning_price = this.local_variables.last_upper_turning_price;
    this._last_upper_turning_price_ts = this.local_variables.last_upper_turning_price_ts;

    // 初始化重置时间
    this._last_grid_count_overtime_reset_ts = this._last_trade_price_ts;
    // this._current_price = this.local_variables.current_price;
    // this._current_price_ts = this.local_variables.current_price_ts;
    // this._tendency = this.local_variables.tendency || 0;
    // this._direction = this.local_variables.direction || 0;

    // 修改网格数据加载逻辑
    // this._grid_base_price = this.local_variables._grid_base_price;
    this._last_reset_grid_count = this.local_variables._last_reset_grid_count || 0;
  }

  _saveState() {
    this.local_variables.is_position_created = this._is_position_created;
    this.local_variables.last_trade_price = this._last_trade_price;
    this.local_variables.last_trade_price_ts = this._last_trade_price_ts;
    this.local_variables.last_lower_turning_price = this._last_lower_turning_price;
    this.local_variables.last_lower_turning_price_ts = this._last_lower_turning_price_ts;
    this.local_variables.last_upper_turning_price = this._last_upper_turning_price;
    this.local_variables.last_upper_turning_price_ts = this._last_upper_turning_price_ts;
    this.local_variables.prev_price = this._prev_price;
    this.local_variables.current_price = this._current_price;
    this.local_variables.current_price_ts = this._current_price_ts;
    this.local_variables.tendency = this._tendency;
    this.local_variables.direction = this._direction;
    this.local_variables._grid_base_price = this._grid_base_price; // 添加网格数据的保存
    this.local_variables._grid_base_price_ts = this._grid_base_price_ts; // 添加网格数据的保存
    this.local_variables._min_price = this._min_price;
    this.local_variables._max_price = this._max_price;
    this.local_variables._grid_width = this._grid_width;
    this.local_variables._last_reset_grid_count = this._last_reset_grid_count;
  }

  _refreshTurningPoint() {
    if (this._direction === 1 && this._tendency === -1) {
      // 趋势向下，瞬时向上，更新下拐点
      if (!this._last_lower_turning_price || this._current_price < this._last_lower_turning_price) {
        this._last_lower_turning_price = this._prev_price;
        this._last_lower_turning_price_ts = this._prev_price_ts;
      }
    } else if (this._direction === -1 && this._tendency === 1) {
      // 趋势向上，瞬时向下，更新上拐点
      if (!this._last_upper_turning_price || this._current_price > this._last_upper_turning_price) {
        this._last_upper_turning_price = this._prev_price;
        this._last_upper_turning_price_ts = this._prev_price_ts;
      }
    }
  }

  // 计算回撤范围
  _correction() {
    // 计算回撤范围
    if (this._direction > 0) {
      // 趋势向上，计算反弹范围
      return (
        (this._current_price - this._last_lower_turning_price) / this._last_lower_turning_price
      );
    }

    if (this._direction < 0) {
      // 趋势向下，计算回撤范围
      return (
        (this._current_price - this._last_upper_turning_price) / this._last_upper_turning_price
      );
    }
    return 0;
  }

  display() {
    // this._drawGridTrading(this.engine._bar_type);
  }

  /**
   * 瞬时波动率计算函数
   * @param {*} recentPrices 秒级价格
   * @returns
   */
  /**
   * 波动率计算函数
   * @param {Array} recentPrices 价格序列
   * @param {number} p 计算周期，默认14
   * @returns {number} 分钟级波动率
   */
  _calculateVolatility(recentPrices) {
    // 检查输入数据
    if (!recentPrices || recentPrices.length < 2) {
      return 0;
    }

    // 确保使用最新的p个数据点
    const prices = recentPrices;

    // 计算对数收益率
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
      // 使用对数收益率
      const return_rate = Math.log(prices[i] / prices[i - 1]);
      returns.push(return_rate);
    }

    if (returns.length === 0) {
      return 0;
    }

    // 计算收益率的均值
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;

    // 计算方差（使用无偏估计）
    const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (returns.length - 1);

    // 转换为分钟级波动率
    // 假设输入的价格序列是秒级的，需要转换为分钟级
    // 使用时间缩放因子：sqrt(60)，因为波动率与时间的平方根成正比
    return Math.sqrt(variance) * Math.sqrt(60);
  }

  // 计算真实移动平均
  _calculateATR(highs, lows, closes, period = 14) {
    if (highs.length !== lows.length || highs.length !== closes.length) {
      throw new Error('数据长度不一致');
    }
    if (highs.length < period) {
      return []; // 数据不足时返回空数组
    }

    const trs = []; // 存储真实波幅（True Range）
    for (let i = 0; i < highs.length; i++) {
      if (i === 0) {
        // 第一天的 TR 为当日最高价 - 当日最低价
        trs.push(highs[i] - lows[i]);
      } else {
        const tr1 = highs[i] - lows[i]; // 当日最高价 - 当日最低价
        const tr2 = Math.abs(highs[i] - closes[i - 1]); // 当日最高价 - 前日收盘价
        const tr3 = Math.abs(lows[i] - closes[i - 1]); // 当日最低价 - 前日收盘价
        trs.push(Math.max(tr1, tr2, tr3));
      }
    }

    // 计算 ATR（简单移动平均）
    const atr = [];
    for (let i = period - 1; i < trs.length; i++) {
      const sum = trs.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      atr.push(sum / period);
    }

    // 对齐数据长度（前 period-1 个位置填充 null）
    return new Array(period - 1).fill(null).concat(atr);
  }

  getAtr(p = 14) {
    const candles = this.engine.getCandleData(this.asset_name);
    if (candles.length > 14) {
      const highs = candles.map(candle => candle.high);
      const lows = candles.map(candle => candle.low);
      const closes = candles.map(candle => candle.close);
      // 计算ATR
      const atr = this._calculateATR(highs, lows, closes, p);
      return atr[atr.length - 1];
    }
  }

  getVolatility(p = 14) {
    // const prices = this.engine.getCandleData(this.asset_name).map(candle => candle.close);
    const prices = this._recent_prices;
    return this._calculateVolatility(prices.slice(-p));
  }

  getVolume(acc = false) {
    const candles = this.engine.getCandleData(this.asset_name);
    if (acc) {
      return candles.map(candle => candle.vol).reduce((a, b) => a + b, 0);
    }
    return parseFloat(candles.map(candle => candle.vol).at(-1));
  }

  _recordMomentPrice() {
    this._recent_prices.push(this._current_price);
    if (this._recent_prices.length > 60) {
      this._recent_prices = this._recent_prices.slice(-60);
    }
  }

  _calculateMovingAverage(volumeArray, windowSize) {
    // 参数校验：确保输入合法
    if (!Array.isArray(volumeArray) || windowSize <= 0 || windowSize > volumeArray.length) {
      return [];
    }

    const result = [];
    let sum = 0;

    // 计算初始窗口（前 windowSize 个元素）的和
    for (let i = 0; i < windowSize; i++) {
      sum += volumeArray[i];
    }
    result.push(sum / windowSize); // 添加第一个移动平均值

    // 滑动窗口，依次计算后续的移动平均
    for (let i = windowSize; i < volumeArray.length; i++) {
      sum += volumeArray[i] - volumeArray[i - windowSize]; // 更新总和：加上新元素，减去旧元素
      result.push(sum / windowSize); // 添加当前窗口的平均值
    }
    return result;
  }

  getVolumeStandard(n = 3) {
    const candles = this.engine.getCandleData(this.asset_name);

    const volumeArray = candles
      // .filter(candle => candle.confirm > 0)
      .map(candle => parseFloat(candle.vol));

    // 获取最后n根K线数据
    const lastNCandles = candles.slice(-n);
    const { vol: lastVol, ts } = lastNCandles.at(-1); // 最新的K线

    // 计算移动平均
    const windowSize = 30;
    const movingAverages = this._calculateMovingAverage(volumeArray, windowSize);
    const movingAverages_fast = this._calculateMovingAverage(volumeArray, n);
    const lastMovingAverage = movingAverages[movingAverages.length - 1] || 0;
    const lastMovingAverage_fast = movingAverages_fast[movingAverages_fast.length - 1] || 0;

    // 计算当前分钟已经过去的时间（秒）
    const currentTime = Math.floor(Date.now() / 1000);
    const elapsedSeconds = Math.max(1, currentTime - ts / 1000); // 防止除零

    return {
      vol: parseFloat(lastVol), // 当前分钟已成交量
      vol_avg_slow: lastMovingAverage, // 移动平均成交量
      vol_avg_fast: lastMovingAverage_fast, // 移动平均成交量
      second: elapsedSeconds, // 已经过去的秒数
    };
  }

  printIndicators() {
    // 计算波动率
    const volatility = this.getVolatility(30);

    // 计算ATR
    const atr = this.getAtr(14);

    const { vol, vol_avg_fast, vol_avg_slow, second } = this.getVolumeStandard();
    const vol_power = vol_avg_fast / vol_avg_slow;
    console.log(
      `[${this.asset_name}] ATR: ${(atr * 100).toFixed(2)}%; 瞬时波动率: ${(volatility * 100).toFixed(2)}%; VOL:  ${(vol / 1000).toFixed(0)}k/${(vol_avg_fast / 1000).toFixed(0)}k/${(vol_avg_slow / 1000).toFixed(0)}k; 量能: ${(vol_power * 100).toFixed(2)}%; 剩余: ${60 - second}s`
    );
  }
  /**
   * 时间触发器
   * @implements
   */
  tick() {
    // 获取最新价格
    this._current_price = this.engine.getRealtimePrice(this.asset_name) || this._prev_price;
    this._current_price_ts = this.engine.realtime_price_ts[this.asset_name] || this._prev_price_ts;

    // 保存价格记录
    this._recordMomentPrice();

    this.printIndicators();

    // 检查是否需要重置网格
    if (!this._current_price) {
      this._saveState(); // 使用统一的状态保存方法
      return;
    }

    // 如果本地没有网格数据，则初始化
    if (!this._grid.length) {
      this._grid_base_price = this.local_variables._grid_base_price || this._current_price;
      this._grid_base_price_ts = this.local_variables._grid_base_price_ts || this._current_price_ts;

      this._grid = GridTradingProcessor._initPriceGrid(
        this._grid_base_price,
        this._min_price,
        this._max_price,
        this._grid_width
      );
    }

    // 更新价格走向和趋势
    this._direction = this._findPriceDirection();
    this._tendency = this._findPriceTendency();

    // 首次建仓
    if (!this._is_position_created) {
      this._is_position_created = true;
      this._saveState(); // 使用统一的状态保存方法
      return;
    }

    // 价格超出范围检查
    // 优化后的价格范围检查
    if (this._current_price < this._min_price) {
      console.log(`当前价格${this._current_price}低于最低价${this._min_price}，暂停交易`);
      this._saveState();
      return;
    }
    if (this._current_price > this._max_price) {
      console.log(`当前价格${this._current_price}高于最高价${this._max_price}，暂停交易`);
      this._saveState();
      return;
    }

    // 计算当前价格横跨网格
    const gridCount = this._last_trade_price
      ? this._countGridNumber(this._current_price, this._last_trade_price)
      : Math.min(this._countGridNumber(this._current_price, this._grid_base_price), 2);
    // 计算上拐点价横跨网格数量
    const gridTurningCount_upper = this._countGridNumber(
      this._last_upper_turning_price,
      this._last_trade_price
    );
    // 计算下拐点价横跨网格数量
    const gridTurningCount_lower = this._countGridNumber(
      this._last_lower_turning_price,
      this._last_trade_price
    );

    // 更新拐点价格
    this._refreshTurningPoint();

    // 执行交易策略

    this._orderStrategy(gridCount, gridTurningCount_upper, gridTurningCount_lower);

    // 更新历史价格
    this._prev_price = this._current_price;
    this._prev_price_ts = this._current_price_ts;
    this._saveState(); // 使用统一的状态保存方法
    // console.log(this.engine.market_candle['1m']['XRP-USDT']);
  }

  async _orderStrategy(gridCount, gridTurningCount_upper, gridTurningCount_lower) {
    if (this._stratage_locked) return;

    try {
      this._stratage_locked = true;

      // 检查网格数量变化并处理超时重置
      const currentGridCountAbs = Math.abs(gridCount);
      const lastGridCountAbs = Math.abs(this._last_grid_count);

      // 当网格数量增加且超过上次重置的网格数时重置超时时间
      if (currentGridCountAbs > 1 && currentGridCountAbs > this._last_reset_grid_count) {
        console.log(
          `[${this.asset_name}]网格突破新高点：从${this._last_reset_grid_count}增加到${currentGridCountAbs}，重置超时间`
        );
        this._last_grid_count_overtime_reset_ts = this._current_price_ts;
        this._last_reset_grid_count = currentGridCountAbs;
      }

      const timeDiff = (this._current_price_ts - this._last_grid_count_overtime_reset_ts) / 1000;
      // 更新最新网格数量
      this._last_grid_count = gridCount;

      // 趋势和方向一致时不交易
      if (this._tendency == 0 || this._direction / this._tendency >= 0) {
        // console.log(`[${this.asset_name}]价格趋势与方向一致，不进行交易`);
        return;
      }

      const correction = this._correction();
      let threshold = this._direction < 0 ? this._max_drawdown : this._max_bounce;
      const grid_count_abs = Math.abs(gridCount);

      // 退避机制 ---- 在一个格子内做文章
      // 如果大于 5 分钟,则减少回撤门限使其尽快平仓
      // 减少回撤门限，仅限于平仓
      // 通过当前持仓方向与价格趋势方向是否一致来判断是否平仓
      // 持仓方向判断很重要，不能盲目加仓
      // 判断动量，如果涨跌速度过快则不能盲目减少回撤门限

      if (timeDiff > this._backoff_1st_time) {
        threshold *= 0.5;
        console.log(
          `[${this.asset_name}]距离上一次交易时间超过 ${this._backoff_1st_time / 60} 分钟，回撤门限减少为：${(threshold * 100).toFixed(2)}%`
        );
        const diff_rate =
          this._direction > 0
            ? Math.abs(this._current_price - this._last_trade_price) /
              Math.min(this._current_price, this._last_trade_price)
            : Math.abs(this._current_price - this._last_trade_price) /
              Math.max(this._current_price, this._last_trade_price);
        const price_distance_grid = diff_rate / this._grid_width;
        // if (diff_rate > this._grid_width * 0.9) {
        //   threshold *= 0.5;
        //   console.log(
        //     `- 价距 ${(diff_rate * 100).toFixed(2)}% 大于安全距离，回撤门限减少为：${(threshold * 100).toFixed(2)}%`
        //   );
        // }

        if (timeDiff > this._backoff_2nd_time) {
          if (price_distance_grid > 1.5 && this._direction / this._tendency < 0) {
            threshold *= 0.5;
            console.log(
              `[${this.asset_name}]距离上一次交易时间超过 ${this._backoff_2nd_time / 60} 分钟，回撤门限减少为：${(threshold * 100).toFixed(2)}%`
            );
          }
        }

        if (timeDiff > this._backoff_3nd_time) {
          console.log(
            `[${this.asset_name}]距离上一次交易时间超过 ${this._backoff_3nd_time / 60} 分钟，超时直接平仓价差1.5格`
          );

          // TODO 将来只有针对平仓才做
          if (price_distance_grid > 1.5 && this._direction / this._tendency < 0) {
            // 直接平仓会错过收益，所以需要继续减少容限
            const atr = this.getAtr();
            if (Math.abs(correction) > atr * 0.5) {
              console.log(
                `- 回撤 ${(Math.abs(correction) * 100).toFixed(2)}% 大于平均振幅的一半: ${(atr * 100 * 0.5).toFixed(2)}%，直接平仓`
              );
              if (this._direction > 0) await this._placeOrder(-1, '- 超时直接平仓');
              if (this._direction < 0) await this._placeOrder(1, '- 超时直接平仓');
              return;
            } else {
              console.log(
                `- 回撤 ${(Math.abs(correction) * 100).toFixed(2)}% 小于平均振幅的一半: ${(atr * 100 * 0.5).toFixed(2)}%，继续等待回撤`
              );
            }
          }
        }

        console.log(`- 当前价差 ${price_distance_grid.toFixed(2)} 格`);
      }

      // 如果超过两格则回撤判断减半，快速锁定利润
      // 可能还要叠加动量，比如上涨速度过快时，需要允许更大/更小的回撤
      const atr = this.getAtr();
      const is_return_arrived = Math.abs(correction) > Math.min(threshold, atr * 1.5);
      // 回撤/反弹条件是否满足
      if (!is_return_arrived) {
        console.log(
          `[${this.asset_name}]当前回撤/反弹幅度${(correction * 100).toFixed(2)}%，🐢继续等待...`
        );
        return;
      }

      //  todo 不论是回撤还是反弹，都不能超过一个格子，否则会过度反弹高位买入
      if (grid_count_abs >= 1) {
        // 正常满足条件下单
        console.log(
          `[${this.asset_name}]${this._current_price} 价格穿越了 ${gridCount} 个网格，触发策略`
        );
        await this._placeOrder(gridCount, this._direction < 0 ? '- 回撤下单' : '- 反弹下单');
        return;
      }

      // 处理拐点交易逻辑
      if (
        this._enable_none_grid_trading &&
        this._direction < 0 &&
        Math.abs(gridTurningCount_upper) >= 1
      ) {
        console.log(
          `↪️[${this.asset_name}]${this._current_price} 价格穿越了上拐点，触发上拐点回调交易`
        );
        await this._placeOrder(1, '- 格内上穿拐点下单');
        return;
      }

      if (
        this._enable_none_grid_trading &&
        this._direction > 0 &&
        Math.abs(gridTurningCount_lower) >= 1
      ) {
        // 这里应该使用 gridTurningCount_lower
        console.log(
          `↩️[${this.asset_name}]${this._current_price} 价格穿越了下拐点，触发下拐点回调交易`
        );
        await this._placeOrder(-1, '- 格内下穿拐点下单');
        return;
      }

      // console.log(`[${this.asset_name}]未触发任何交易条件，继续等待...`);
    } finally {
      // 解锁策略
      this._stratage_locked = false;
    }
  }

  static _initPriceGrid(base_price, _min_price, _max_price, _grid_width) {
    const grid = [];
    const basePrice = base_price;

    if (_min_price >= _max_price) {
      throw new Error(`[网格生成]最低价必须小于最高价`);
    }
    if (!(_min_price <= basePrice && basePrice <= _max_price)) {
      throw new Error(`[网格生成]基准价格必须在最低价和最高价之间`);
    }

    // 向上生成网格
    let current_price = basePrice;
    while (current_price < _max_price) {
      current_price += current_price * _grid_width;
      if (current_price <= _max_price) {
        grid.push(Number(current_price.toFixed(3)));
      } else {
        break;
      }
    }

    // 向下生成网格
    current_price = basePrice;
    while (current_price > _min_price) {
      current_price -= current_price * _grid_width;
      if (current_price >= _min_price) {
        grid.unshift(Number(current_price.toFixed(3)));
      } else {
        break;
      }
    }

    // 确保基准价格在网格中
    if (!grid.includes(basePrice)) {
      grid.push(basePrice);
      grid.sort((a, b) => a - b);
    }

    return grid; // 返回生成的网格数组
  }

  _findPriceDirection() {
    if (this._current_price > this._prev_price) {
      return 1; // 价格上涨
    }
    if (this._current_price < this._prev_price) {
      return -1; // 价格下跌
    }
    return 0; // 价格持平
  }

  _findPriceTendency() {
    if (this._current_price > (this._last_trade_price || this._grid_base_price)) {
      return 1; // 价格上涨趋势
    }
    if (this._current_price < (this._last_trade_price || this._grid_base_price)) {
      return -1; // 价格下跌趋势
    }
    return 0; // 价格持平
  }

  _countGridNumber(current, prev) {
    if (current === prev) return 0;
    if (!current || !prev) return 0;

    const lowerPrice = Math.min(current, prev);
    const upperPrice = Math.max(current, prev);

    // 统计在范围内的网格数量
    let count = this._grid.filter(price => price >= lowerPrice && price <= upperPrice).length;

    if (count <= 1) return 0;
    const result = current > prev ? count - 1 : -(count - 1);
    return Math.min(result, this._max_trade_grid_count);
  }

  /**
   * 下单
   * @param {number} gridCount 跨越的网格数量
   * @param {string} orderType 订单类型
   */
  async _placeOrder(gridCount, orderType) {
    const amount = -gridCount * this._trade_amount;

    if (Math.abs(amount) > this._max_position) {
      console.warn(`⚠️ 交易量${amount}超过最大持仓限制${this._max_position}`);
      return;
    }

    console.log(`💰${orderType}：${this._current_price} ${amount} 个`);
    const order = createOrder_market(
      this.asset_name,
      Math.abs(amount),
      amount / Math.abs(amount),
      true
    );
    let result = await executeOrders([order]);
    if (!result.success) {
      console.error(`⛔${this.asset_name} 交易失败: ${orderType}`);
      this._resetKeyPrices(this._last_trade_price, this._last_trade_price_ts);
      return;
    }
    recordGridTradeOrders({ ...result.data[0], gridCount });
    console.log(`✅${this.asset_name} 交易成功: ${orderType}`);
    // 重置关键参数
    this._resetKeyPrices(this._current_price, this._current_price_ts);
    this._saveState(); // 立即保存状态
    try {
      const [o] = (await fetchOrders(result.data)) || [];
      if (o && o.avgPx && o.fillTime) {
        this._resetKeyPrices(parseFloat(o.avgPx), parseFloat(o.fillTime));
        console.log(
          `✅${this.asset_name} 远程重置关键参数成功`,
          parseFloat(o.avgPx),
          parseFloat(o.fillTime)
        );
      } else {
        console.error(`⛔${this.asset_name} 远程重置关键参数失败: 未获取到订单信息`);
      }
    } catch (e) {
      console.error(`⛔${this.asset_name} 远程重置关键参数失败: ${e.message}`);
    }
  }

  /**
   * 重置关键参数
   * @param {number} price 最新价格
   * @param {number} ts 最新价格时间戳
   */
  _resetKeyPrices(price, ts) {
    // 重置关键参数
    this._last_trade_price = price;
    this._last_trade_price_ts = ts;
    this._last_grid_count_overtime_reset_ts = ts;
    // 重置拐点
    this._last_lower_turning_price = price;
    this._last_lower_turning_price_ts = ts;

    this._last_upper_turning_price = price;
    this._last_upper_turning_price_ts = ts;
    // 重置基准点
    // this._grid_base_price = this._current_price;
    // this._grid_base_price_ts = this._current_price_ts;
    this._prev_price = price; // 重置前一价格
    this._prev_price_ts = ts;
    // 交易成功后重置标记，允许下一轮首次突破重置
    // 重置网格计数
    this._last_reset_grid_count = 0;
  }
}
